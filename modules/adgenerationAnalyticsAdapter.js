import { logInfo, logError, logWarn } from '../src/utils.js';
import adapter from '../libraries/analyticsAdapter/AnalyticsAdapter.js';
import adapterManager, { coppaDataHandler, gdprDataHandler, gppDataHandler, uspDataHandler } from '../src/adapterManager.js';
import { EVENTS } from '../src/constants.js';
import { ajax, sendBeacon } from '../src/ajax.js';
import { getRefererInfo } from '../src/refererDetection.js';

/**
 * @typedef {import('./adgenerationAnalyticsAdapter.d.ts').AdgenerationAnalyticsAdapterOptions} AdgenerationAnalyticsAdapterOptions
 */

const PROVIDER_CODE = 'adgeneration';
const ANALYTICS_VERSION = '2.0.0';
/** 送信本文の形式のバージョン。 */
const PAYLOAD_VERSION = 1;
/** 送信先として受理するドメイン（完全一致またはサブドメイン）。 */
const ALLOWED_ENDPOINT_DOMAINS = ['socdm.com', 'scaleout.jp'];
/** 後追いイベント判定用に保持する auction 数の上限（超えたら古いものから破棄）。 */
const REGISTRY_MAX_AUCTIONS = 50;
/** 送信待ちイベントをまとめる待ち時間（ms）の既定値と上限。 */
const DEFAULT_BATCH_DELAY = 1000;
const MAX_BATCH_DELAY = 5000;
/** 1 回に送る本文の上限（バイト）。sendBeacon の上限 64KB に余裕を残す。 */
const MAX_BODY_BYTES = 60 * 1024;
/** 送信割合の判定に使うハッシュの剰余。割合は 0.01% 単位になる。 */
const SAMPLING_BUCKETS = 10000;

const {
  AUCTION_INIT,
  BID_REQUESTED,
  BID_RESPONSE,
  NO_BID,
  BID_TIMEOUT,
  BID_REJECTED,
  AUCTION_END,
  BID_WON,
  AD_RENDER_FAILED,
  BID_VIEWABLE,
} = EVENTS;

const LOG_PREFIX = `${PROVIDER_CODE} analytics: `;

/**
 * アダプターの状態。テストから初期化できるよう export する。
 */
export const locals = {
  /**
   * enable 中か。disable（同意の撤回・activity control での拒否）の間は送らない。
   * 基盤の enabled は過去イベントの replay が終わってから true になるため、独自に持つ。
   */
  active: false,
  /** @type {string|null} 送信先。null なら何も送らない */
  endpoint: null,
  /** 送る割合（0〜1）。ADG の bid request の bidId のハッシュで判定する */
  ratio: 0,
  /** 送信待ちイベントをまとめる待ち時間（ms） */
  batchDelay: DEFAULT_BATCH_DELAY,
  /** @type {Object<string, Object>} auctionId -> AUCTION_END まで蓄積するオークション集約データ */
  auctions: {},
  /**
   * AUCTION_END 後も後追いイベントを判定するための送信対象枠の記録。
   * auctionId -> { units: { adUnitCode -> ADG の bidId[] }, adIds: { adId -> adUnitCode } }
   * 挿入順に REGISTRY_MAX_AUCTIONS 件まで保持する。
   * @type {Object<string, Object>}
   */
  registry: {},
  /** @type {string[]} registry の auctionId（古い順） */
  registryOrder: [],
  /** @type {Object[]} 送信待ちのイベント */
  queue: [],
  /** queue の各イベントを JSON にしたときのバイト数の合計 */
  queueBytes: 0,
  /** @type {*} queue を送り出すタイマー */
  timer: null,
  reset() {
    if (this.timer) clearTimeout(this.timer);
    this.active = false;
    this.endpoint = null;
    this.ratio = 0;
    this.batchDelay = DEFAULT_BATCH_DELAY;
    this.auctions = {};
    this.registry = {};
    this.registryOrder = [];
    this.queue = [];
    this.queueBytes = 0;
    this.timer = null;
  },
};

function byteLength(str) {
  return new TextEncoder().encode(str).length;
}

/**
 * FNV-1a 32bit（文字列を UTF-8 のバイト列として計算し、符号なし整数を返す）。
 * 受信側が bidId から送信対象かを再現できるよう、判定方法は仕様として共有する。
 * テストから検証できるよう export する。
 */
export function fnv1a32(str) {
  const bytes = new TextEncoder().encode(String(str));
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * bidId が送信対象かを判定する: hash(bidId) % 10000 < round(ratio × 10000)。
 * テストから検証できるよう export する。
 */
export function isSampled(bidId, ratio) {
  if (!bidId || !(ratio > 0)) return false;
  return fnv1a32(bidId) % SAMPLING_BUCKETS < Math.round(ratio * SAMPLING_BUCKETS);
}

/**
 * 送信先 URL を検証する。https かつ許可ドメイン（およびサブドメイン）のみ受理する。
 * テストから検証できるよう export する。
 */
export function isAllowedEndpoint(value) {
  if (typeof value !== 'string' || !value) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return ALLOWED_ENDPOINT_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
  } catch (e) {
    return false;
  }
}

function isAdgBidder(bidder) {
  return !!bidder && adapterManager.resolveAlias(bidder) === PROVIDER_CODE;
}

/**
 * AUCTION_END で送信対象枠を registry に登録し、上限を超えたら古い auction から破棄する。
 */
function registerTargets(auctionId, units, adIds) {
  if (!locals.registry[auctionId]) {
    locals.registryOrder.push(auctionId);
  }
  locals.registry[auctionId] = { units, adIds };
  while (locals.registryOrder.length > REGISTRY_MAX_AUCTIONS) {
    delete locals.registry[locals.registryOrder.shift()];
  }
}

/**
 * 後追いイベントの対象枠なら、その枠の ADG の bidId の配列を返す（対象外は undefined）。
 */
function lookupTargetBidIds(auctionId, adUnitCode) {
  const entry = locals.registry[auctionId];
  return entry && entry.units[adUnitCode];
}

/**
 * adId から対象枠の (auctionId, adUnitCode) を逆引きする。
 * AD_RENDER_FAILED で bid が付かない場合（CANNOT_FIND_AD 等）に使う。
 */
function findTargetByAdId(adId) {
  if (!adId) return null;
  for (let i = locals.registryOrder.length - 1; i >= 0; i--) {
    const auctionId = locals.registryOrder[i];
    const adUnitCode = locals.registry[auctionId].adIds[adId];
    if (adUnitCode) return { auctionId, adUnitCode };
  }
  return null;
}

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
    targets: {}, // adUnitCode -> 送信対象に当たった ADG の bidId[]
  };
}

function onBidRequested({ auctionId, bids = [] }) {
  bids.forEach((bid) => {
    const entry = getBidderEntry(auctionId, bid.adUnitCode, bid.bidder);
    if (!entry) return;
    entry.status = 'requested';
    // ADG の bid request（alias 含む）の bidId で、この枠を送るかを決める。
    // bidId は ADG へのリクエストの imp.id と同じ値で、timeout の枠でも取れる。
    if (isAdgBidder(bid.bidder) && isSampled(bid.bidId, locals.ratio)) {
      const targets = locals.auctions[auctionId].targets;
      const ids = (targets[bid.adUnitCode] = targets[bid.adUnitCode] || []);
      if (!ids.includes(bid.bidId)) ids.push(bid.bidId);
    }
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

/**
 * 送信対象枠ごと・ADG の bidId ごとに auctionEnd イベントを 1 件積む。
 * 中身はその枠の全 bidder の状態（他 bidder の入札も含む）。
 */
function onAuctionEnd({ auctionId }) {
  const auction = locals.auctions[auctionId];
  if (!auction) return;
  delete locals.auctions[auctionId];
  const codes = Object.keys(auction.targets).filter((code) => auction.adUnits[code]);
  // 対象枠が 1 つも無い auction は何も送らない。
  if (!codes.length) return;

  // 後追いイベント用に対象枠と、その枠の bid の adId を記録する。
  // rejectedBids は描画されないため adRenderFailed 逆引き用の adId には登録しない。
  const units = {};
  const adIds = {};
  codes.forEach((code) => {
    const bidIds = auction.targets[code];
    units[code] = bidIds;
    const bidders = auction.adUnits[code].bidders;
    Object.keys(bidders).forEach((bidder) => {
      (bidders[bidder].bids || []).forEach(({ adId }) => {
        if (adId) adIds[adId] = code;
      });
    });
    bidIds.forEach((bidId) => {
      enqueue(buildEvent('auctionEnd', bidId, auctionId, code, { bidders }));
    });
  });
  registerTargets(auctionId, units, adIds);
}

/**
 * 後追いイベントを、対象枠の ADG の bidId ごとに積む（対象外の枠は何もしない）。
 */
function enqueueFollowUp(type, auctionId, adUnitCode, data) {
  const bidIds = lookupTargetBidIds(auctionId, adUnitCode);
  if (!bidIds) return;
  bidIds.forEach((bidId) => enqueue(buildEvent(type, bidId, auctionId, adUnitCode, data)));
}

function onBidWon(bid) {
  enqueueFollowUp('bidWon', bid.auctionId, bid.adUnitCode, {
    bidder: bid.bidderCode,
    ...pickBidFields(bid),
  });
}

function onAdRenderFailed(args) {
  const bid = args.bid;
  const adId = args.adId || (bid && bid.adId);
  // bid が付かない場合（CANNOT_FIND_AD 等）は AUCTION_END で記録した adId から枠を逆引きする。
  const target = bid
    ? { auctionId: bid.auctionId, adUnitCode: bid.adUnitCode }
    : findTargetByAdId(adId);
  if (!target) return;
  enqueueFollowUp('adRenderFailed', target.auctionId, target.adUnitCode, {
    adId,
    reason: args.reason,
    message: args.message,
  });
}

function onBidViewable(bid) {
  enqueueFollowUp('viewable', bid.auctionId, bid.adUnitCode, {
    adId: bid.adId, // bids[] / bidWon と突合するためのキー
    bidder: bid.bidderCode,
    mediaType: bid.mediaType,
  });
}

/**
 * 送信本文の events 配列に入れる 1 件を作る。テストから検証できるよう export する。
 */
export function buildEvent(type, bidId, auctionId, adUnitCode, data) {
  return {
    type,
    ts: Date.now(),
    bidId,
    auctionId,
    adUnitCode,
    data,
  };
}

/**
 * ページ単位の値（版・ページ URL・同意情報）。送信本文の最上位に 1 回だけ置く。
 * テストから検証できるよう export する。
 */
export function buildEnvelope() {
  return addConsentData({
    v: PAYLOAD_VERSION,
    analyticsVersion: ANALYTICS_VERSION,
    pbjsVersion: '$prebid.version$', // ビルドスクリプトで実バージョンに置換される
    page: getRefererInfo().page || window.location.href,
  });
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
 * イベントを送信待ちの列に積む。
 * - 列が空のときに積んだら待ち時間のタイマーを張る（後続のイベントで延長しない）
 * - 積むと本文が上限を超える場合は、先に今の列を送ってから積む
 * - 待ち時間 0 は待たずに送る
 */
function enqueue(event) {
  if (!locals.active || !locals.endpoint) return;
  const eventBytes = byteLength(JSON.stringify(event));
  if (locals.queue.length) {
    // 本文 = 最上位の値 + events 配列（イベント間のカンマを含む）
    const projected = byteLength(JSON.stringify(buildEnvelope())) + locals.queueBytes +
      eventBytes + locals.queue.length + 20;
    if (projected > MAX_BODY_BYTES) flush();
  }
  locals.queue.push(event);
  locals.queueBytes += eventBytes;
  if (locals.batchDelay === 0) {
    flush();
  } else if (!locals.timer) {
    locals.timer = setTimeout(flush, locals.batchDelay);
  }
}

/**
 * 送信待ちの列をまとめて 1 本で送る。テストから呼べるよう export する。
 */
export function flush() {
  if (locals.timer) {
    clearTimeout(locals.timer);
    locals.timer = null;
  }
  // disable 中は送らない（列は残し、再 enable で送る）。
  if (!locals.active || !locals.queue.length) return;
  const events = locals.queue;
  locals.queue = [];
  locals.queueBytes = 0;
  if (!locals.endpoint) return;
  send({ ...buildEnvelope(), events });
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

/**
 * タブが隠れた・ページを離れるときは、待たずに列を送る（待ち時間中に閉じられると消えるため）。
 */
let unloadListenersAdded = false;
function addUnloadListeners() {
  if (unloadListenersAdded) return;
  unloadListenersAdded = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', flush);
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
    case AD_RENDER_FAILED:
      onAdRenderFailed(args);
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

function resolveOptions(options) {
  if (isAllowedEndpoint(options.endpoint)) {
    locals.endpoint = options.endpoint;
  } else {
    if (options.endpoint !== undefined) {
      logError(`${LOG_PREFIX}endpoint must be https on socdm.com or scaleout.jp, nothing will be sent`, options.endpoint);
    } else {
      logWarn(`${LOG_PREFIX}no endpoint, nothing will be sent`);
    }
    locals.endpoint = null;
  }

  const ratio = options.ratio;
  if (typeof ratio === 'number' && ratio >= 0 && ratio <= 1) {
    locals.ratio = ratio;
  } else {
    if (ratio !== undefined) logError(`${LOG_PREFIX}ratio must be a number between 0 and 1, using 0`, ratio);
    locals.ratio = 0;
  }

  const delay = options.batchDelay;
  if (typeof delay === 'number' && delay >= 0 && delay <= MAX_BATCH_DELAY) {
    locals.batchDelay = delay;
  } else {
    if (delay !== undefined) logError(`${LOG_PREFIX}batchDelay must be 0-${MAX_BATCH_DELAY} ms, using ${DEFAULT_BATCH_DELAY}`, delay);
    locals.batchDelay = DEFAULT_BATCH_DELAY;
  }
}

/**
 * @param {{provider: string, options?: AdgenerationAnalyticsAdapterOptions}} config
 */
function enableAnalyticsWrapper(config) {
  const options = (config && config.options) || {};
  resolveOptions(options);
  locals.active = true;
  let baseConfig = config;
  if (options.sampling !== undefined) {
    // 基盤の options.sampling はセッション単位の抽選で、bidId による判定と二重になり受信側で再現できない。
    logWarn(`${LOG_PREFIX}options.sampling is ignored, use options.ratio`);
    const { sampling, ...rest } = options;
    baseConfig = { ...config, options: rest };
  }
  addUnloadListeners();
  logInfo(`${LOG_PREFIX}enabled`, baseConfig);
  adgAnalytics.originEnableAnalytics(baseConfig);
  // disable 中に残った送信待ちの列があれば、待ち時間を張り直す。
  if (locals.queue.length && !locals.timer) {
    if (locals.batchDelay === 0) {
      flush();
    } else {
      locals.timer = setTimeout(flush, locals.batchDelay);
    }
  }
}

adgAnalytics.originEnableAnalytics = adgAnalytics.enableAnalytics;
adgAnalytics.enableAnalytics = enableAnalyticsWrapper;

adgAnalytics.originDisableAnalytics = adgAnalytics.disableAnalytics;
adgAnalytics.disableAnalytics = function () {
  // 基盤の disable は enableAnalytics を素の実装へ差し戻すため、このラッパーを _oldEnable に戻して恒久的な喪失を防ぐ。
  adgAnalytics._oldEnable = enableAnalyticsWrapper;
  // consent 変化時の disable→enable では、基盤の replay が flush 済みウォーターマークより後のイベントしか再送しない。
  // 進行中オークションの track 済みイベント（AUCTION_INIT 等）は再構築できないため、locals（auctions・registry・
  // 送信待ちの列・送信先）は保持する。次の enable で設定は必ず再設定される。
  // ただし disable は同意の撤回などで呼ばれるため、送信は止める（タイマーを外し、離脱時のリスナーでも送らない）。
  // 基盤は disable で debounce の列を捨てるが、disable 後に track が呼ばれた場合に備えて enqueue でも止める。
  locals.active = false;
  if (locals.timer) {
    clearTimeout(locals.timer);
    locals.timer = null;
  }
  adgAnalytics.originDisableAnalytics();
};

adapterManager.registerAnalyticsAdapter({
  adapter: adgAnalytics,
  code: PROVIDER_CODE,
  // GDPR 対応時に gvlid を設定する
});

export default adgAnalytics;
