import { logInfo, logError } from '../src/utils.js';
import adapter from '../libraries/analyticsAdapter/AnalyticsAdapter.js';
import adapterManager, { coppaDataHandler, gdprDataHandler, gppDataHandler, uspDataHandler } from '../src/adapterManager.js';
import { EVENTS } from '../src/constants.js';
import { ajax, sendBeacon } from '../src/ajax.js';
import { getRefererInfo } from '../src/refererDetection.js';

const PROVIDER_CODE = 'adgeneration';
const ANALYTICS_VERSION = '1.0.0';
const GVLID = undefined; // ADG の GDPR Vendor List ID。GDPR 対応時に設定する
const DEFAULT_ENDPOINT = 'https://d.socdm.com/adgen/analytics';

const {
  AUCTION_INIT,
  BID_REQUESTED,
  BID_RESPONSE,
  NO_BID,
  BID_TIMEOUT,
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
  Object.assign(entry, {
    status: 'bid',
    cpm: bid.cpm,
    currency: bid.currency,
    originalCpm: bid.originalCpm,
    originalCurrency: bid.originalCurrency,
    timeToRespond: bid.timeToRespond,
    mediaType: bid.mediaType,
    size: bid.size,
    creativeId: bid.creativeId,
    dealId: bid.dealId,
  });
}

function onNoBid({ auctionId, adUnitCode, bidder }) {
  const entry = getBidderEntry(auctionId, adUnitCode, bidder);
  if (entry) entry.status = 'noBid';
}

function onBidTimeout(args = []) {
  args.forEach(({ auctionId, adUnitCode, bidder }) => {
    const entry = getBidderEntry(auctionId, adUnitCode, bidder);
    if (entry) entry.status = 'timeout';
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
    cpm: bid.cpm,
    currency: bid.currency,
    mediaType: bid.mediaType,
    size: bid.size,
    creativeId: bid.creativeId,
    dealId: bid.dealId,
  });
}

function onAdRender(eventType, args) {
  send({
    type: eventType === AD_RENDER_SUCCEEDED ? 'adRenderSucceeded' : 'adRenderFailed',
    auctionId: args.bid && args.bid.auctionId,
    adUnitCode: args.adUnitCode || (args.bid && args.bid.adUnitCode),
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
 * オークション集約データを送信用レポートに整形し、同意情報を同梱する。
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
  return addConsentData(report);
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
 * Content-Type は preflight(OPTIONS) を避けるため text/plain とする（サーバー側で JSON パースする）。
 */
function send(payload) {
  const body = JSON.stringify(payload);
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

const adgAnalytics = Object.assign(adapter({ analyticsType: 'endpoint' }), {
  track: handleEvent,
});

adgAnalytics.originEnableAnalytics = adgAnalytics.enableAnalytics;
adgAnalytics.enableAnalytics = function (config) {
  const options = (config && config.options) || {};
  if (options.endpoint && typeof options.endpoint === 'string' && options.endpoint.startsWith('http')) {
    locals.endpoint = options.endpoint;
  } else {
    if (options.endpoint) {
      logError(`${LOG_PREFIX}invalid endpoint, using default`, options.endpoint);
    }
    locals.endpoint = DEFAULT_ENDPOINT;
  }
  logInfo(`${LOG_PREFIX}enabled`, config);
  adgAnalytics.originEnableAnalytics(config);
};

adgAnalytics.originDisableAnalytics = adgAnalytics.disableAnalytics;
adgAnalytics.disableAnalytics = function () {
  locals.reset();
  adgAnalytics.originDisableAnalytics();
};

adapterManager.registerAnalyticsAdapter({
  adapter: adgAnalytics,
  code: PROVIDER_CODE,
  gvlid: GVLID,
});

export default adgAnalytics;
