import adapterManager, {
  gdprDataHandler,
  uspDataHandler,
  gppDataHandler,
  coppaDataHandler,
} from '../../../src/adapterManager.js';
import adgAnalyticsAdapter, {
  locals,
  fnv1a32,
  isSampled,
  isAllowedEndpoint,
  buildEnvelope,
  flush,
} from '../../../modules/adgenerationAnalyticsAdapter.js';
import { expect } from 'chai';
import * as events from '../../../src/events.js';
import * as utils from '../../../src/utils.js';
import { EVENTS } from '../../../src/constants.js';
import { server } from '../../mocks/xhr.js';

const PROVIDER_CODE = 'adgeneration';
const ENDPOINT = 'https://d.socdm.com/adgen/analytics';
const CUSTOM_ENDPOINT = 'https://api-test.scaleout.jp/adgen/analytics';

// テスト環境では基盤の track の debounce が 0 のため（test/mocks/analyticsStub.js）、イベントは同期で処理される。
const BATCH_DELAY = 1000;

const AUCTION_ID = 'test-auction-id';
const AD_UNIT_CODE = 'div-gpt-ad-1';
const AD_UNIT_CODE_2 = 'div-gpt-ad-2';
const AD_ID = 'test-ad-id-1';
const ADG_BID_ID = 'adg-bid-1';
const ADG_BID_ID_2 = 'adg-bid-2';

const auctionInit = {
  auctionId: AUCTION_ID,
  timestamp: 1700000000000,
};

const bidRequested = {
  auctionId: AUCTION_ID,
  bids: [
    { adUnitCode: AD_UNIT_CODE, bidder: 'adgeneration', bidId: ADG_BID_ID },
    { adUnitCode: AD_UNIT_CODE, bidder: 'rubicon', bidId: 'rubicon-bid-1' },
  ],
};

const bidResponse = {
  auctionId: AUCTION_ID,
  adUnitCode: AD_UNIT_CODE,
  bidderCode: 'adgeneration',
  adId: AD_ID,
  cpm: 120.5,
  currency: 'JPY',
  originalCpm: 120.5,
  originalCurrency: 'JPY',
  timeToRespond: 240,
  mediaType: 'banner',
  size: '300x250',
  creativeId: 'creative-1',
  dealId: '',
};

const bidWon = {
  auctionId: AUCTION_ID,
  adUnitCode: AD_UNIT_CODE,
  bidderCode: 'adgeneration',
  adId: AD_ID,
  cpm: 120.5,
  currency: 'JPY',
  mediaType: 'banner',
  size: '300x250',
  creativeId: 'creative-1',
  dealId: '',
};

describe('ADG Analytics Adapter', () => {
  let sandbox;
  let clock;
  let sendBeaconStub;

  function enable(options = {}) {
    adgAnalyticsAdapter.enableAnalytics({
      provider: PROVIDER_CODE,
      options: { endpoint: ENDPOINT, ratio: 1, ...options },
    });
  }

  /** 送られた本文を古い順に返す。 */
  function sentBodies() {
    return sendBeaconStub.getCalls().map((call) => JSON.parse(call.args[1]));
  }

  /** 送られた全イベントを古い順に返す。 */
  function sentEvents() {
    return sentBodies().flatMap((body) => body.events);
  }

  function runAuction() {
    events.emit(EVENTS.AUCTION_INIT, auctionInit);
    events.emit(EVENTS.BID_REQUESTED, bidRequested);
    events.emit(EVENTS.BID_RESPONSE, bidResponse);
    events.emit(EVENTS.NO_BID, { auctionId: AUCTION_ID, adUnitCode: AD_UNIT_CODE, bidder: 'rubicon' });
    events.emit(EVENTS.AUCTION_END, { auctionId: AUCTION_ID });
  }

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    clock = sandbox.useFakeTimers();
    // enableAnalytics 時に過去イベントを拾わないようにする
    sandbox.stub(events, 'getEvents').returns([]);
    sendBeaconStub = sandbox.stub(navigator, 'sendBeacon').returns(true);
    // 同意情報はデフォルトで無しにし、payload を素の状態で検証できるようにする
    sandbox.stub(gdprDataHandler, 'getConsentData').returns(null);
    sandbox.stub(uspDataHandler, 'getConsentData').returns(null);
    sandbox.stub(gppDataHandler, 'getConsentData').returns(null);
    sandbox.stub(coppaDataHandler, 'getCoppa').returns(false);
  });

  afterEach(() => {
    // disableAnalytics は _oldEnable にカスタム enable ラッパーを戻すため、
    // 未有効化の状態で呼んでも以降のテストでラッパーが失われることはない。
    adgAnalyticsAdapter.disableAnalytics();
    // disableAnalytics は replay 整合のため locals を保持するので、分離はここで明示的に行う。
    locals.reset();
    sandbox.restore();
  });

  describe('configuration', () => {
    it('registers itself with the adapter manager', () => {
      const adapter = adapterManager.getAnalyticsAdapter(PROVIDER_CODE);
      expect(adapter).to.exist;
      expect(adapter.adapter).to.equal(adgAnalyticsAdapter);
    });

    it('accepts an https endpoint on an allowed domain', () => {
      enable({ endpoint: CUSTOM_ENDPOINT });
      expect(locals.endpoint).to.equal(CUSTOM_ENDPOINT);
    });

    it('sends nothing when no endpoint is configured', () => {
      adgAnalyticsAdapter.enableAnalytics({ provider: PROVIDER_CODE, options: { ratio: 1 } });
      expect(locals.endpoint).to.be.null;
      runAuction();
      clock.tick(BATCH_DELAY);
      expect(sendBeaconStub.called).to.be.false;
      expect(server.requests).to.have.lengthOf(0);
    });

    it('rejects endpoints that are not https or not on an allowed domain', () => {
      ['http://d.socdm.com/adgen/analytics', 'https://example.com/analytics', 'https://socdm.com.evil.com/a', 'not-a-url']
        .forEach((endpoint) => {
          enable({ endpoint });
          expect(locals.endpoint, endpoint).to.be.null;
          adgAnalyticsAdapter.disableAnalytics();
        });
    });

    it('defaults ratio to 0 and batchDelay to 1000', () => {
      adgAnalyticsAdapter.enableAnalytics({ provider: PROVIDER_CODE, options: { endpoint: ENDPOINT } });
      expect(locals.ratio).to.equal(0);
      expect(locals.batchDelay).to.equal(1000);
    });

    it('falls back to defaults for out-of-range ratio / batchDelay', () => {
      enable({ ratio: 1.5, batchDelay: 6000 });
      expect(locals.ratio).to.equal(0);
      expect(locals.batchDelay).to.equal(1000);
      adgAnalyticsAdapter.disableAnalytics();
      enable({ ratio: '0.5', batchDelay: -1 });
      expect(locals.ratio).to.equal(0);
      expect(locals.batchDelay).to.equal(1000);
    });

    it('does not pass options.sampling to the analytics base (session sampling)', () => {
      const randomStub = sandbox.stub(Math, 'random').returns(0.99);
      enable({ sampling: 0.01 });
      randomStub.restore();
      runAuction();
      clock.tick(BATCH_DELAY);
      // 基盤がセッション抽選をしていれば、0.99 >= 0.01 で無効化されて何も送られない。
      expect(sendBeaconStub.calledOnce).to.be.true;
    });

    it('validates endpoints with isAllowedEndpoint', () => {
      expect(isAllowedEndpoint('https://socdm.com/a')).to.be.true;
      expect(isAllowedEndpoint('https://d.socdm.com/a')).to.be.true;
      expect(isAllowedEndpoint('https://x.scaleout.jp/a')).to.be.true;
      expect(isAllowedEndpoint('https://notsocdm.com/a')).to.be.false;
      expect(isAllowedEndpoint('http://d.socdm.com/a')).to.be.false;
      expect(isAllowedEndpoint(undefined)).to.be.false;
    });
  });

  describe('sampling by bidId', () => {
    it('matches the published FNV-1a 32bit test vectors', () => {
      expect(fnv1a32('')).to.equal(0x811c9dc5);
      expect(fnv1a32('a')).to.equal(0xe40c292c);
      expect(fnv1a32('foobar')).to.equal(0xbf9cf968);
    });

    it('selects no bidId at ratio 0 and every bidId at ratio 1', () => {
      for (let i = 0; i < 200; i++) {
        const bidId = utils.generateUUID();
        expect(isSampled(bidId, 0)).to.be.false;
        expect(isSampled(bidId, 1)).to.be.true;
      }
    });

    it('uses hash(bidId) % 10000 < round(ratio * 10000) as the boundary', () => {
      const bidId = 'boundary-check';
      const bucket = fnv1a32(bidId) % 10000;
      expect(isSampled(bidId, (bucket + 1) / 10000)).to.be.true;
      expect(isSampled(bidId, bucket / 10000)).to.be.false;
    });

    it('selects roughly ratio of Prebid-style bidIds', () => {
      const total = 10000;
      let hits = 0;
      for (let i = 0; i < total; i++) {
        if (isSampled(utils.generateUUID(), 0.1)) hits++;
      }
      expect(hits / total).to.be.within(0.08, 0.12);
    });

    it('sends nothing when the ADG bidId is not selected', () => {
      enable({ ratio: 0 });
      runAuction();
      clock.tick(BATCH_DELAY);
      expect(sendBeaconStub.called).to.be.false;
    });

    it('sends nothing for slots without an ADG bid request', () => {
      enable();
      events.emit(EVENTS.AUCTION_INIT, auctionInit);
      events.emit(EVENTS.BID_REQUESTED, {
        auctionId: AUCTION_ID,
        bids: [{ adUnitCode: AD_UNIT_CODE, bidder: 'rubicon', bidId: 'rubicon-bid-1' }],
      });
      events.emit(EVENTS.AUCTION_END, { auctionId: AUCTION_ID });
      clock.tick(BATCH_DELAY);
      expect(sendBeaconStub.called).to.be.false;
    });

    it('detects ADG bid requests made through an alias', () => {
      const resolveStub = sandbox.stub(adapterManager, 'resolveAlias');
      resolveStub.callsFake((bidder) => (bidder === 'adg' ? 'adgeneration' : bidder));
      enable();
      events.emit(EVENTS.AUCTION_INIT, auctionInit);
      events.emit(EVENTS.BID_REQUESTED, {
        auctionId: AUCTION_ID,
        bids: [{ adUnitCode: AD_UNIT_CODE, bidder: 'adg', bidId: ADG_BID_ID }],
      });
      events.emit(EVENTS.AUCTION_END, { auctionId: AUCTION_ID });
      clock.tick(BATCH_DELAY);

      const sent = sentEvents();
      expect(sent).to.have.lengthOf(1);
      expect(sent[0].bidId).to.equal(ADG_BID_ID);
      expect(sent[0].data.bidders.adg.status).to.equal('requested');
    });
  });

  describe('auctionEnd events', () => {
    beforeEach(() => {
      enable();
    });

    it('sends one auctionEnd event per selected slot with all bidders', () => {
      runAuction();
      clock.tick(BATCH_DELAY);

      expect(sendBeaconStub.calledOnce).to.be.true;
      const [url, body] = sendBeaconStub.getCall(0).args;
      expect(url).to.equal(ENDPOINT);

      const payload = JSON.parse(body);
      expect(payload.v).to.equal(1);
      expect(payload.analyticsVersion).to.equal('2.0.0');
      expect(payload.pbjsVersion).to.exist;
      expect(payload.page).to.be.a('string');
      expect(payload.events).to.have.lengthOf(1);

      const event = payload.events[0];
      expect(event.type).to.equal('auctionEnd');
      expect(event.bidId).to.equal(ADG_BID_ID);
      expect(event.auctionId).to.equal(AUCTION_ID);
      expect(event.adUnitCode).to.equal(AD_UNIT_CODE);
      expect(event.ts).to.be.a('number');
      const bidders = event.data.bidders;
      expect(bidders.adgeneration.status).to.equal('bid');
      expect(bidders.adgeneration.bids).to.have.lengthOf(1);
      expect(bidders.adgeneration.bids[0].adId).to.equal(AD_ID);
      expect(bidders.adgeneration.bids[0].cpm).to.equal(120.5);
      expect(bidders.rubicon.status).to.equal('noBid');
    });

    it('sends a slot where ADG timed out (bidId is known from BID_REQUESTED)', () => {
      events.emit(EVENTS.AUCTION_INIT, auctionInit);
      events.emit(EVENTS.BID_REQUESTED, bidRequested);
      events.emit(EVENTS.BID_TIMEOUT, [
        { auctionId: AUCTION_ID, adUnitCode: AD_UNIT_CODE, bidder: 'adgeneration', bidId: ADG_BID_ID },
      ]);
      events.emit(EVENTS.AUCTION_END, { auctionId: AUCTION_ID });
      clock.tick(BATCH_DELAY);

      const [event] = sentEvents();
      expect(event.bidId).to.equal(ADG_BID_ID);
      expect(event.data.bidders.adgeneration.status).to.equal('timeout');
    });

    it('records timeout status when BID_TIMEOUT args are object-shaped (analyticsLabels)', () => {
      events.emit(EVENTS.AUCTION_INIT, auctionInit);
      events.emit(EVENTS.BID_REQUESTED, bidRequested);
      events.emit(EVENTS.BID_TIMEOUT, {
        analyticsLabels: { foo: 'bar' },
        0: { auctionId: AUCTION_ID, adUnitCode: AD_UNIT_CODE, bidder: 'rubicon' },
      });
      events.emit(EVENTS.AUCTION_END, { auctionId: AUCTION_ID });
      clock.tick(BATCH_DELAY);

      expect(sentEvents()[0].data.bidders.rubicon.status).to.equal('timeout');
    });

    it('records rejected status and reason on BID_REJECTED', () => {
      events.emit(EVENTS.AUCTION_INIT, auctionInit);
      events.emit(EVENTS.BID_REQUESTED, bidRequested);
      events.emit(EVENTS.BID_REJECTED, {
        ...bidResponse,
        rejectionReason: 'Bid does not meet price floor',
      });
      events.emit(EVENTS.AUCTION_END, { auctionId: AUCTION_ID });
      clock.tick(BATCH_DELAY);

      const adg = sentEvents()[0].data.bidders.adgeneration;
      expect(adg.status).to.equal('rejected');
      expect(adg.rejectedBids[0].reason).to.equal('Bid does not meet price floor');
    });

    it('keeps status "bid" even if a later BID_TIMEOUT / BID_REJECTED arrives', () => {
      events.emit(EVENTS.AUCTION_INIT, auctionInit);
      events.emit(EVENTS.BID_REQUESTED, bidRequested);
      events.emit(EVENTS.BID_RESPONSE, bidResponse);
      events.emit(EVENTS.BID_TIMEOUT, [
        { auctionId: AUCTION_ID, adUnitCode: AD_UNIT_CODE, bidder: 'adgeneration' },
      ]);
      events.emit(EVENTS.BID_REJECTED, { ...bidResponse, rejectionReason: 'x' });
      events.emit(EVENTS.AUCTION_END, { auctionId: AUCTION_ID });
      clock.tick(BATCH_DELAY);

      expect(sentEvents()[0].data.bidders.adgeneration.status).to.equal('bid');
    });

    it('accumulates multiple BID_RESPONSE for the same bidder', () => {
      events.emit(EVENTS.AUCTION_INIT, auctionInit);
      events.emit(EVENTS.BID_REQUESTED, bidRequested);
      events.emit(EVENTS.BID_RESPONSE, bidResponse);
      events.emit(EVENTS.BID_RESPONSE, { ...bidResponse, adId: 'ad-2', cpm: 80, mediaType: 'video' });
      events.emit(EVENTS.AUCTION_END, { auctionId: AUCTION_ID });
      clock.tick(BATCH_DELAY);

      expect(sentEvents()[0].data.bidders.adgeneration.bids).to.have.lengthOf(2);
    });

    it('sends one event per selected ADG bidId when a slot has several ADG bid requests', () => {
      events.emit(EVENTS.AUCTION_INIT, auctionInit);
      events.emit(EVENTS.BID_REQUESTED, {
        auctionId: AUCTION_ID,
        bids: [
          { adUnitCode: AD_UNIT_CODE, bidder: 'adgeneration', bidId: ADG_BID_ID },
          { adUnitCode: AD_UNIT_CODE, bidder: 'adgeneration', bidId: ADG_BID_ID_2 },
        ],
      });
      events.emit(EVENTS.AUCTION_END, { auctionId: AUCTION_ID });
      clock.tick(BATCH_DELAY);

      expect(sentEvents().map((e) => e.bidId)).to.deep.equal([ADG_BID_ID, ADG_BID_ID_2]);
    });

    it('sends only the selected slots of an auction', () => {
      // ratio 1 のまま、2 枠目には ADG の bid request を入れない。
      events.emit(EVENTS.AUCTION_INIT, auctionInit);
      events.emit(EVENTS.BID_REQUESTED, {
        auctionId: AUCTION_ID,
        bids: [
          { adUnitCode: AD_UNIT_CODE, bidder: 'adgeneration', bidId: ADG_BID_ID },
          { adUnitCode: AD_UNIT_CODE_2, bidder: 'rubicon', bidId: 'rubicon-bid-2' },
        ],
      });
      events.emit(EVENTS.AUCTION_END, { auctionId: AUCTION_ID });
      clock.tick(BATCH_DELAY);

      const sent = sentEvents();
      expect(sent).to.have.lengthOf(1);
      expect(sent[0].adUnitCode).to.equal(AD_UNIT_CODE);
    });

    it('clears the auction cache after AUCTION_END', () => {
      runAuction();
      expect(locals.auctions[AUCTION_ID]).to.be.undefined;
    });
  });

  describe('follow-up events', () => {
    beforeEach(() => {
      enable();
      runAuction();
      clock.tick(BATCH_DELAY);
      sendBeaconStub.resetHistory();
    });

    it('sends a bidWon event for a selected slot', () => {
      events.emit(EVENTS.BID_WON, bidWon);
      clock.tick(BATCH_DELAY);

      const [event] = sentEvents();
      expect(event.type).to.equal('bidWon');
      expect(event.bidId).to.equal(ADG_BID_ID);
      expect(event.data.bidder).to.equal('adgeneration');
      expect(event.data.cpm).to.equal(120.5);
      // adId は auctionEnd の bids[] と bidWon を突合するためのキー。
      expect(event.data.adId).to.equal(AD_ID);
    });

    it('sends a viewable event for a selected slot', () => {
      events.emit(EVENTS.BID_VIEWABLE, {
        auctionId: AUCTION_ID,
        adUnitCode: AD_UNIT_CODE,
        adId: AD_ID,
        bidderCode: 'adgeneration',
        mediaType: 'banner',
      });
      clock.tick(BATCH_DELAY);

      const [event] = sentEvents();
      expect(event.type).to.equal('viewable');
      expect(event.bidId).to.equal(ADG_BID_ID);
      expect(event.data.adId).to.equal(AD_ID);
    });

    it('sends an adRenderFailed event, resolving the slot by adId when no bid is attached', () => {
      events.emit(EVENTS.AD_RENDER_FAILED, {
        reason: 'cannotFindAd',
        message: `Cannot find ad '${AD_ID}'`,
        adId: AD_ID,
      });
      clock.tick(BATCH_DELAY);

      const [event] = sentEvents();
      expect(event.type).to.equal('adRenderFailed');
      expect(event.bidId).to.equal(ADG_BID_ID);
      expect(event.auctionId).to.equal(AUCTION_ID);
      expect(event.adUnitCode).to.equal(AD_UNIT_CODE);
      expect(event.data.reason).to.equal('cannotFindAd');
    });

    it('ignores follow-up events for slots that were not selected', () => {
      events.emit(EVENTS.BID_WON, { ...bidWon, adUnitCode: AD_UNIT_CODE_2 });
      events.emit(EVENTS.BID_WON, { ...bidWon, auctionId: 'other-auction' });
      events.emit(EVENTS.AD_RENDER_FAILED, { reason: 'cannotFindAd', adId: 'unknown-ad' });
      clock.tick(BATCH_DELAY);
      expect(sendBeaconStub.called).to.be.false;
    });

    it('does not send AD_RENDER_SUCCEEDED', () => {
      events.emit(EVENTS.AD_RENDER_SUCCEEDED, {
        adId: AD_ID,
        bid: { auctionId: AUCTION_ID, adUnitCode: AD_UNIT_CODE, adId: AD_ID },
      });
      clock.tick(BATCH_DELAY);
      expect(sendBeaconStub.called).to.be.false;
    });

    it('keeps at most 50 auctions for follow-up events', () => {
      for (let i = 0; i < 50; i++) {
        const auctionId = `auction-${i}`;
        events.emit(EVENTS.AUCTION_INIT, { auctionId, timestamp: 1 });
        events.emit(EVENTS.BID_REQUESTED, {
          auctionId,
          bids: [{ adUnitCode: AD_UNIT_CODE, bidder: 'adgeneration', bidId: `bid-${i}` }],
        });
        events.emit(EVENTS.AUCTION_END, { auctionId });
      }
      clock.tick(BATCH_DELAY);
      sendBeaconStub.resetHistory();

      // 最初の auction（beforeEach の AUCTION_ID）は押し出されている。
      events.emit(EVENTS.BID_WON, bidWon);
      events.emit(EVENTS.BID_WON, { ...bidWon, auctionId: 'auction-49' });
      clock.tick(BATCH_DELAY);
      const sent = sentEvents();
      expect(sent).to.have.lengthOf(1);
      expect(sent[0].auctionId).to.equal('auction-49');
    });
  });

  describe('batching', () => {
    it('sends events in one request after batchDelay from the first event', () => {
      enable();
      runAuction();
      events.emit(EVENTS.BID_WON, bidWon);
      expect(sendBeaconStub.called).to.be.false;

      clock.tick(BATCH_DELAY);
      expect(sendBeaconStub.calledOnce).to.be.true;
      expect(sentEvents().map((e) => e.type)).to.deep.equal(['auctionEnd', 'bidWon']);
    });

    it('does not extend the wait for later events, and starts a new wait after sending', () => {
      enable();
      runAuction();
      clock.tick(800);
      events.emit(EVENTS.BID_WON, bidWon);
      expect(sendBeaconStub.called).to.be.false;
      // 最初のイベントを積んでから 1000ms で、後から積んだ bidWon も一緒に送られる（待ち時間は延びない）。
      clock.tick(BATCH_DELAY - 800);
      expect(sendBeaconStub.calledOnce).to.be.true;
      expect(sentEvents()).to.have.lengthOf(2);

      events.emit(EVENTS.BID_VIEWABLE, { ...bidWon });
      clock.tick(BATCH_DELAY - 1);
      expect(sendBeaconStub.calledOnce).to.be.true;
      clock.tick(1);
      expect(sendBeaconStub.calledTwice).to.be.true;
      expect(sentBodies()[1].events[0].type).to.equal('viewable');
    });

    it('honors options.batchDelay', () => {
      enable({ batchDelay: 3000 });
      runAuction();
      clock.tick(2999);
      expect(sendBeaconStub.called).to.be.false;
      clock.tick(1);
      expect(sendBeaconStub.calledOnce).to.be.true;
    });

    it('sends each event immediately when batchDelay is 0', () => {
      enable({ batchDelay: 0 });
      runAuction();
      expect(sendBeaconStub.calledOnce).to.be.true;
      events.emit(EVENTS.BID_WON, bidWon);
      expect(sendBeaconStub.calledTwice).to.be.true;
    });

    it('splits the request before the body exceeds 60KB', () => {
      enable();
      const big = 'x'.repeat(25 * 1024);
      const codes = ['slot-1', 'slot-2', 'slot-3'];
      events.emit(EVENTS.AUCTION_INIT, auctionInit);
      events.emit(EVENTS.BID_REQUESTED, {
        auctionId: AUCTION_ID,
        bids: codes.map((code, i) => ({ adUnitCode: code, bidder: 'adgeneration', bidId: `bid-${i}` })),
      });
      codes.forEach((code) => {
        events.emit(EVENTS.BID_RESPONSE, { ...bidResponse, adUnitCode: code, creativeId: big });
      });
      events.emit(EVENTS.AUCTION_END, { auctionId: AUCTION_ID });
      // 3 件目を積むと 60KB を超えるため、先に 2 件で送る。
      expect(sendBeaconStub.calledOnce).to.be.true;
      expect(sentBodies()[0].events).to.have.lengthOf(2);

      clock.tick(BATCH_DELAY);
      expect(sendBeaconStub.calledTwice).to.be.true;
      expect(sentBodies()[1].events).to.have.lengthOf(1);
      sendBeaconStub.getCalls().forEach((call) => {
        expect(new TextEncoder().encode(call.args[1]).length).to.be.below(60 * 1024);
      });
    });

    it('sends pending events immediately on pagehide', () => {
      enable();
      runAuction();
      expect(sendBeaconStub.called).to.be.false;
      window.dispatchEvent(new Event('pagehide'));
      expect(sendBeaconStub.calledOnce).to.be.true;
      // 送った後にタイマーが残っていないこと。
      clock.tick(BATCH_DELAY);
      expect(sendBeaconStub.calledOnce).to.be.true;
    });

    it('sends pending events immediately when the page becomes hidden', () => {
      enable();
      runAuction();
      sandbox.stub(document, 'visibilityState').get(() => 'hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      expect(sendBeaconStub.calledOnce).to.be.true;
    });

    it('does nothing on visibilitychange while the page is visible', () => {
      enable();
      runAuction();
      sandbox.stub(document, 'visibilityState').get(() => 'visible');
      document.dispatchEvent(new Event('visibilitychange'));
      expect(sendBeaconStub.called).to.be.false;
    });

    it('flush() with an empty queue sends nothing', () => {
      enable();
      flush();
      expect(sendBeaconStub.called).to.be.false;
    });
  });

  describe('transport fallback', () => {
    it('falls back to ajax when sendBeacon is unavailable', () => {
      enable();
      sendBeaconStub.returns(false);
      runAuction();
      clock.tick(BATCH_DELAY);

      expect(server.requests.length).to.equal(1);
      expect(server.requests[0].url).to.equal(ENDPOINT);
      expect(server.requests[0].method).to.equal('POST');
      const payload = JSON.parse(server.requests[0].requestBody);
      expect(payload.events[0].type).to.equal('auctionEnd');
    });
  });

  describe('consent data', () => {
    it('puts consent data once at the top level of the body', () => {
      gdprDataHandler.getConsentData.returns({
        gdprApplies: true,
        consentString: 'consent-string',
      });
      uspDataHandler.getConsentData.returns('1YNN');
      enable();
      runAuction();
      clock.tick(BATCH_DELAY);

      const [payload] = sentBodies();
      expect(payload.gdpr).to.equal(1);
      expect(payload.gdprConsent).to.equal('consent-string');
      expect(payload.usPrivacy).to.equal('1YNN');
      expect(payload.events[0]).to.not.have.property('gdpr');
    });

    it('omits consent fields when no consent data is present', () => {
      const envelope = buildEnvelope();
      expect(envelope).to.not.have.property('gdpr');
      expect(envelope).to.not.have.property('usPrivacy');
      expect(envelope).to.not.have.property('gpp');
      expect(envelope).to.not.have.property('coppa');
    });
  });

  describe('disable / enable cycle', () => {
    it('keeps in-flight auction data and pending events across a disable / enable cycle', () => {
      enable();
      events.emit(EVENTS.AUCTION_INIT, auctionInit);
      events.emit(EVENTS.BID_REQUESTED, bidRequested);
      events.emit(EVENTS.BID_RESPONSE, bidResponse);

      // consent 変化時に adapterManager.refreshAnalytics が行う disable→enable を再現する。
      adgAnalyticsAdapter.disableAnalytics();
      expect(locals.auctions[AUCTION_ID]).to.exist;

      enable();
      events.emit(EVENTS.AUCTION_END, { auctionId: AUCTION_ID });
      clock.tick(BATCH_DELAY);

      const [event] = sentEvents();
      expect(event.bidId).to.equal(ADG_BID_ID);
      // disable 前に track した BID_RESPONSE が残っていること。
      expect(event.data.bidders.adgeneration.status).to.equal('bid');
      expect(event.data.bidders.rubicon.status).to.equal('requested');
    });

    it('does not send pending events while disabled (consent withdrawn)', () => {
      enable();
      runAuction();
      expect(locals.queue).to.have.lengthOf(1);

      // 同意の撤回などで adapterManager.refreshAnalytics が disable する。
      adgAnalyticsAdapter.disableAnalytics();
      clock.tick(BATCH_DELAY * 2);
      window.dispatchEvent(new Event('pagehide'));
      flush();
      expect(sendBeaconStub.called).to.be.false;
      expect(server.requests).to.have.lengthOf(0);
      // 列は残す（再 enable で送る）。
      expect(locals.queue).to.have.lengthOf(1);
    });

    it('does not queue events that reach track after a disable', () => {
      enable();
      events.emit(EVENTS.AUCTION_INIT, auctionInit);
      events.emit(EVENTS.BID_REQUESTED, bidRequested);
      adgAnalyticsAdapter.disableAnalytics();
      // 基盤は disable で debounce の列を捨てるが、disable 後に track が直接呼ばれても積まないこと。
      adgAnalyticsAdapter.track({ eventType: EVENTS.AUCTION_END, args: { auctionId: AUCTION_ID } });
      clock.tick(BATCH_DELAY);
      expect(locals.queue).to.have.lengthOf(0);
      expect(sendBeaconStub.called).to.be.false;
    });

    it('sends events kept during a disable after re-enabling', () => {
      enable();
      runAuction();
      adgAnalyticsAdapter.disableAnalytics();
      clock.tick(BATCH_DELAY * 2);
      expect(sendBeaconStub.called).to.be.false;

      enable();
      clock.tick(BATCH_DELAY - 1);
      expect(sendBeaconStub.called).to.be.false;
      clock.tick(1);
      expect(sendBeaconStub.calledOnce).to.be.true;
      expect(sentEvents()[0].bidId).to.equal(ADG_BID_ID);
    });

    it('keeps the custom enable wrapper after a disable', () => {
      enable({ endpoint: CUSTOM_ENDPOINT });
      adgAnalyticsAdapter.disableAnalytics();
      expect(locals.endpoint).to.equal(CUSTOM_ENDPOINT);

      // ラッパーが失われていなければ、再 enable で設定が再設定される。
      enable({ endpoint: ENDPOINT, ratio: 0.5 });
      expect(locals.endpoint).to.equal(ENDPOINT);
      expect(locals.ratio).to.equal(0.5);
    });
  });
});
