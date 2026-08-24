import { logInfo, logError } from '../src/utils.js';
import adapter from '../libraries/analyticsAdapter/AnalyticsAdapter.js';
import adapterManager, { coppaDataHandler, gdprDataHandler, gppDataHandler, uspDataHandler } from '../src/adapterManager.js';
import { EVENTS } from '../src/constants.js';
import { ajax, sendBeacon } from '../src/ajax.js';
import { getRefererInfo } from '../src/refererDetection.js';

const PROVIDER_CODE = 'adgeneration';
const ANALYTICS_VERSION = '1.0.0';
const DEFAULT_ENDPOINT = 'https://d.socdm.com/adgen/analytics';

const {
  AUCTION_INIT,
  BID_REQUESTED,
  BID_RESPONSE,
  NO_BID,
  BID_TIMEOUT,
  BID_REJECTED,
  AUCTION_END,
  BID_WON,
  AD_RENDER_SUCCEEDED,
  AD_RENDER_FAILED,
  BID_VIEWABLE,
} = EVENTS;

const LOG_PREFIX = `${PROVIDER_CODE} analytics: `;

/**
 * オークション単位でイベントを蓄積し、AUCTION_END でまとめて送信するためのキャッシュ。
 * BID_WON / AD_RENDER_* / BID_VIEWABLE は後追いで個別送信する。
 * テストから状態を初期化できるよう export する。
 */
export const locals = {
  endpoint: DEFAULT_ENDPOINT,
  /** @type {Object<string, Object>} auctionId -> オークション集約データ */
  auctions: {},
  reset() {
    this.endpoint = DEFAULT_ENDPOINT;
    this.auctions = {};
  },
};

/**
 * BID_RESPONSE / BID_REJECTED / BID_WON で共通して bid から抜き出すフィールド。
 * adId は multibid 時に bids[] と bidWon を突合するための一意キー（BID_REJECTED では存在しないことがある）。
 */
function pickBidFields(bid) {
  return {
    adId: bid.adId,
    cpm: bid.cpm,
    currency: bid.currency,
    originalCpm: bid.originalCpm,
    originalCurrency: bid.originalCurrency,
    timeToRespond: bid.timeToRespond,
    mediaType: bid.mediaType,
    size: bid.size,
    creativeId: bid.creativeId,
    dealId: bid.dealId,
  };
}

/**
 * 指定 adUnit の bidder 集計エントリを取得（無ければ生成）する。
 */
function getBidderEntry(auctionId, adUnitCode, bidder) {
  const auction = locals.auctions[auctionId];
  if (!auction || !adUnitCode || !bidder) return null;
  const unit = (auction.adUnits[adUnitCode] = auction.adUnits[adUnitCode] || { bidders: {} });
  const entry = (unit.bidders[bidder] = unit.bidders[bidder] || {});
  return entry;
}

function onAuctionInit({ auctionId, timestamp }) {
  if (!auctionId) return;
  locals.auctions[auctionId] = {
    auctionId,
    timestamp,
    adUnits: {}, // adUnitCode -> { bidders: { [bidder]: {...} } }
  };
}

function onBidRequested({ auctionId, bids = [] }) {
  bids.forEach((bid) => {
    const entry = getBidderEntry(auctionId, bid.adUnitCode, bid.bidder);
    if (entry) entry.status = 'requested';
  });
}

function onBidResponse(bid) {
  const entry = getBidderEntry(bid.auctionId, bid.adUnitCode, bid.bidderCode);
  if (!entry) return;
  // BID_RESPONSE は他ステータスに優先して常に 'bid' とする。
  entry.status = 'bid';
  // マルチフォーマット / multibid で同一 bidder から複数応答が来るため配列に積む。
  (entry.bids = entry.bids || []).push(pickBidFields(bid));
}

function onNoBid({ auctionId, adUnitCode, bidder }) {
  const entry = getBidderEntry(auctionId, adUnitCode, bidder);
  if (entry && entry.status !== 'bid') entry.status = 'noBid';
}

function onBidTimeout(args) {
  // analytics 基盤はラベル付与時に配列 args をオブジェクト化する（{analyticsLabels, 0: bid, 1: bid}）ため両形に対応する。
  const bids = Array.isArray(args)
    ? args
    : Object.keys(args || {}).filter((k) => k !== 'analyticsLabels').map((k) => args[k]);
  bids.forEach(({ auctionId, adUnitCode, bidder }) => {
    const entry = getBidderEntry(auctionId, adUnitCode, bidder);
    if (entry && entry.status !== 'bid') entry.status = 'timeout';
  });
}

function onBidRejected(bid) {
  const entry = getBidderEntry(bid.auctionId, bid.adUnitCode, bid.bidderCode || bid.bidder);
  if (!entry) return;
  if (entry.status !== 'bid') entry.status = 'rejected';
  (entry.rejectedBids = entry.rejectedBids || []).push({
    ...pickBidFields(bid),
    reason: bid.rejectionReason,
  });
}

function onAuctionEnd({ auctionId }) {
  const auction = locals.auctions[auctionId];
  if (!auction) return;
  send(buildAuctionReport(auction));
  delete locals.auctions[auctionId];
}

function onBidWon(bid) {
  send({
    type: 'bidWon',
    auctionId: bid.auctionId,
    adUnitCode: bid.adUnitCode,
    bidder: bid.bidderCode,
    ...pickBidFields(bid),
  });
}

function onAdRender(eventType, args) {
  const bid = args.bid;
  send({
    type: eventType, // 定数値が 'adRenderSucceeded' / 'adRenderFailed' そのものなので変換不要
    auctionId: bid && bid.auctionId,
    adUnitCode: bid && bid.adUnitCode,
    adId: args.adId || (bid && bid.adId),
    reason: args.reason, // FAILED のみ存在（undefined は JSON.stringify で落ちる）
    message: args.message, // 同上
  });
}

function onBidViewable(bid) {
  send({
    type: 'viewable',
    auctionId: bid.auctionId,
    adUnitCode: bid.adUnitCode,
    bidder: bid.bidderCode,
    mediaType: bid.mediaType,
  });
}

/**
 * オークション集約データを送信用レポートに整形する。同意情報は send() で付与する。
 * テストから検証できるよう export する。
 */
export function buildAuctionReport(auction) {
  const report = {
    type: 'auction',
    analyticsVersion: ANALYTICS_VERSION,
    pbjsVersion: '$prebid.version$', // ビルドスクリプトで実バージョンに置換される
    referrer: getRefererInfo().page || window.location.href,
    auctionId: auction.auctionId,
    timestamp: auction.timestamp,
    adUnits: auction.adUnits,
  };
  return report;
}

/**
 * GDPR / USP / GPP / COPPA の同意情報を付与する（取得できた場合のみ）。
 */
function addConsentData(report) {
  const usp = uspDataHandler.getConsentData();
  if (usp) {
    report.usPrivacy = usp;
  }
  const gdpr = gdprDataHandler.getConsentData();
  if (gdpr) {
    report.gdpr = Number(Boolean(gdpr.gdprApplies));
    report.gdprConsent = gdpr.consentString || '';
  }
  const gpp = gppDataHandler.getConsentData();
  if (gpp) {
    report.gpp = gpp.gppString;
    report.gppSid = gpp.applicableSections;
  }
  if (coppaDataHandler.getCoppa()) {
    report.coppa = Number(coppaDataHandler.getCoppa());
  }
  return report;
}

/**
 * ページ遷移後も欠損しにくい sendBeacon を優先し、利用不可なら ajax にフォールバックする。
 * 同意情報はここで付与し、集約送信・後追い送信の双方で確実に同梱されるようにする。
 * Content-Type は preflight(OPTIONS) を避けるため text/plain とする（サーバー側で JSON パースする）。
 */
function send(payload) {
  const body = JSON.stringify(addConsentData(payload));
  if (sendBeacon(locals.endpoint, body)) {
    logInfo(`${LOG_PREFIX}report sent`, payload);
    return;
  }
  ajax(locals.endpoint, null, body, {
    contentType: 'text/plain',
    method: 'POST',
    keepalive: true,
  });
}

function handleEvent({ eventType, args }) {
  switch (eventType) {
    case AUCTION_INIT:
      onAuctionInit(args);
      break;
    case BID_REQUESTED:
      onBidRequested(args);
      break;
    case BID_RESPONSE:
      onBidResponse(args);
      break;
    case NO_BID:
      onNoBid(args);
      break;
    case BID_TIMEOUT:
      onBidTimeout(args);
      break;
    case BID_REJECTED:
      onBidRejected(args);
      break;
    case AUCTION_END:
      onAuctionEnd(args);
      break;
    case BID_WON:
      onBidWon(args);
      break;
    case AD_RENDER_SUCCEEDED:
    case AD_RENDER_FAILED:
      onAdRender(eventType, args);
      break;
    case BID_VIEWABLE:
      onBidViewable(args);
      break;
    default:
      break;
  }
}

/**
 * endpoint が http(s) の絶対 URL かどうかを検証する。
 */
function isValidEndpoint(value) {
  if (typeof value !== 'string') return false;
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch (e) {
    return false;
  }
}

const adgAnalytics = Object.assign(adapter({ analyticsType: 'endpoint' }), {
  track: handleEvent,
});

function enableAnalyticsWrapper(config) {
  const options = (config && config.options) || {};
  if (isValidEndpoint(options.endpoint)) {
    locals.endpoint = options.endpoint;
  } else {
    if (options.endpoint) {
      logError(`${LOG_PREFIX}invalid endpoint, using default`, options.endpoint);
    }
    locals.endpoint = DEFAULT_ENDPOINT;
  }
  logInfo(`${LOG_PREFIX}enabled`, config);
  adgAnalytics.originEnableAnalytics(config);
}

adgAnalytics.originEnableAnalytics = adgAnalytics.enableAnalytics;
adgAnalytics.enableAnalytics = enableAnalyticsWrapper;

adgAnalytics.originDisableAnalytics = adgAnalytics.disableAnalytics;
adgAnalytics.disableAnalytics = function () {
  // 基盤の disable は enableAnalytics を素の実装へ差し戻すため、このラッパーを _oldEnable に戻して恒久的な喪失を防ぐ。
  adgAnalytics._oldEnable = enableAnalyticsWrapper;
  // consent 変化時の disable→enable では、基盤の replay が flush 済みウォーターマークより後のイベントしか再送しない。
  // 進行中オークションの track 済みイベント（AUCTION_INIT 等）は再構築できないため locals.auctions は保持する。
  // endpoint も保持する（基盤の debounce queue は disable でクリアされないため、直後に flush される
  // pending イベントを正しい宛先へ送る。次の enable で必ず再設定される）。
  adgAnalytics.originDisableAnalytics();
};

adapterManager.registerAnalyticsAdapter({
  adapter: adgAnalytics,
  code: PROVIDER_CODE,
  // GDPR 対応時に gvlid を設定する
});

export default adgAnalytics;
