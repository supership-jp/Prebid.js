import adapterManager, {
  gdprDataHandler,
  uspDataHandler,
  gppDataHandler,
  coppaDataHandler,
} from '../../../src/adapterManager.js';
import adgAnalyticsAdapter, {
  locals,
  buildAuctionReport,
} from '../../../modules/adgenerationAnalyticsAdapter.js';
import { expect } from 'chai';
import * as events from '../../../src/events.js';
import { EVENTS } from '../../../src/constants.js';
import { server } from '../../mocks/xhr.js';

const PROVIDER_CODE = 'adgeneration';
const DEFAULT_ENDPOINT = 'https://d.socdm.com/adgen/analytics';
const CUSTOM_ENDPOINT = 'https://api-test.scaleout.jp/adgen/analytics';

const AUCTION_ID = 'test-auction-id';
const AD_UNIT_CODE = 'div-gpt-ad-1';

const auctionInit = {
  auctionId: AUCTION_ID,
  timestamp: 1700000000000,
};

const bidRequested = {
  auctionId: AUCTION_ID,
  bids: [
    { adUnitCode: AD_UNIT_CODE, bidder: 'adgeneration', bidId: 'bid-1' },
    { adUnitCode: AD_UNIT_CODE, bidder: 'rubicon', bidId: 'bid-2' },
  ],
};

const bidResponse = {
  auctionId: AUCTION_ID,
  adUnitCode: AD_UNIT_CODE,
  bidderCode: 'adgeneration',
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
    adgAnalyticsAdapter.disableAnalytics();
    sandbox.restore();
  });

  describe('configuration', () => {
    it('registers itself with the adapter manager', () => {
      const adapter = adapterManager.getAnalyticsAdapter(PROVIDER_CODE);
      expect(adapter).to.exist;
      expect(adapter.adapter).to.equal(adgAnalyticsAdapter);
    });

    it('uses the default endpoint when none is provided', () => {
      adgAnalyticsAdapter.enableAnalytics({ provider: PROVIDER_CODE, options: {} });
      expect(locals.endpoint).to.equal(DEFAULT_ENDPOINT);
    });

    it('uses a custom endpoint when provided', () => {
      adgAnalyticsAdapter.enableAnalytics({
        provider: PROVIDER_CODE,
        options: { endpoint: CUSTOM_ENDPOINT },
      });
      expect(locals.endpoint).to.equal(CUSTOM_ENDPOINT);
    });

    it('falls back to the default endpoint for an invalid endpoint', () => {
      adgAnalyticsAdapter.enableAnalytics({
        provider: PROVIDER_CODE,
        options: { endpoint: 'not-a-url' },
      });
      expect(locals.endpoint).to.equal(DEFAULT_ENDPOINT);
    });
  });

  describe('auction batching', () => {
    beforeEach(() => {
      adgAnalyticsAdapter.enableAnalytics({ provider: PROVIDER_CODE, options: {} });
    });

    it('sends one auction report on AUCTION_END with all bidders', () => {
      events.emit(EVENTS.AUCTION_INIT, auctionInit);
      events.emit(EVENTS.BID_REQUESTED, bidRequested);
      events.emit(EVENTS.BID_RESPONSE, bidResponse);
      events.emit(EVENTS.NO_BID, { auctionId: AUCTION_ID, adUnitCode: AD_UNIT_CODE, bidder: 'rubicon' });
      events.emit(EVENTS.AUCTION_END, { auctionId: AUCTION_ID });
      clock.tick(101);

      expect(sendBeaconStub.calledOnce).to.be.true;
      const [url, body] = sendBeaconStub.getCall(0).args;
      expect(url).to.equal(DEFAULT_ENDPOINT);

      const report = JSON.parse(body);
      expect(report.type).to.equal('auction');
      expect(report.auctionId).to.equal(AUCTION_ID);
      const bidders = report.adUnits[AD_UNIT_CODE].bidders;
      expect(bidders.adgeneration.status).to.equal('bid');
      expect(bidders.adgeneration.cpm).to.equal(120.5);
      expect(bidders.adgeneration.mediaType).to.equal('banner');
      expect(bidders.rubicon.status).to.equal('noBid');
    });

    it('records timeout status on BID_TIMEOUT', () => {
      events.emit(EVENTS.AUCTION_INIT, auctionInit);
      events.emit(EVENTS.BID_REQUESTED, bidRequested);
      events.emit(EVENTS.BID_TIMEOUT, [
        { auctionId: AUCTION_ID, adUnitCode: AD_UNIT_CODE, bidder: 'rubicon' },
      ]);
      events.emit(EVENTS.AUCTION_END, { auctionId: AUCTION_ID });
      clock.tick(101);

      const report = JSON.parse(sendBeaconStub.getCall(0).args[1]);
      expect(report.adUnits[AD_UNIT_CODE].bidders.rubicon.status).to.equal('timeout');
    });

    it('clears the auction cache after sending', () => {
      events.emit(EVENTS.AUCTION_INIT, auctionInit);
      events.emit(EVENTS.AUCTION_END, { auctionId: AUCTION_ID });
      clock.tick(101);
      expect(locals.auctions[AUCTION_ID]).to.be.undefined;
    });
  });

  describe('follow-up events', () => {
    beforeEach(() => {
      adgAnalyticsAdapter.enableAnalytics({ provider: PROVIDER_CODE, options: {} });
    });

    it('sends a bidWon report on BID_WON', () => {
      events.emit(EVENTS.BID_WON, bidWon);
      clock.tick(101);

      expect(sendBeaconStub.calledOnce).to.be.true;
      const report = JSON.parse(sendBeaconStub.getCall(0).args[1]);
      expect(report.type).to.equal('bidWon');
      expect(report.bidder).to.equal('adgeneration');
      expect(report.cpm).to.equal(120.5);
    });

    it('sends a viewable report on BID_VIEWABLE', () => {
      events.emit(EVENTS.BID_VIEWABLE, {
        auctionId: AUCTION_ID,
        adUnitCode: AD_UNIT_CODE,
        bidderCode: 'adgeneration',
        mediaType: 'banner',
      });
      clock.tick(101);

      const report = JSON.parse(sendBeaconStub.getCall(0).args[1]);
      expect(report.type).to.equal('viewable');
      expect(report.adUnitCode).to.equal(AD_UNIT_CODE);
    });

    it('sends an adRenderSucceeded report on AD_RENDER_SUCCEEDED', () => {
      events.emit(EVENTS.AD_RENDER_SUCCEEDED, {
        adUnitCode: AD_UNIT_CODE,
        bid: { auctionId: AUCTION_ID, adUnitCode: AD_UNIT_CODE },
      });
      clock.tick(101);

      const report = JSON.parse(sendBeaconStub.getCall(0).args[1]);
      expect(report.type).to.equal('adRenderSucceeded');
      expect(report.auctionId).to.equal(AUCTION_ID);
    });
  });

  describe('transport fallback', () => {
    beforeEach(() => {
      adgAnalyticsAdapter.enableAnalytics({ provider: PROVIDER_CODE, options: {} });
    });

    it('falls back to ajax when sendBeacon is unavailable', () => {
      sendBeaconStub.returns(false);
      events.emit(EVENTS.BID_WON, bidWon);
      clock.tick(101);

      expect(server.requests.length).to.equal(1);
      expect(server.requests[0].url).to.equal(DEFAULT_ENDPOINT);
      expect(server.requests[0].method).to.equal('POST');
      const report = JSON.parse(server.requests[0].requestBody);
      expect(report.type).to.equal('bidWon');
    });
  });

  describe('buildAuctionReport', () => {
    it('includes GDPR consent data when present', () => {
      gdprDataHandler.getConsentData.returns({
        gdprApplies: true,
        consentString: 'consent-string',
      });
      const report = buildAuctionReport({
        auctionId: AUCTION_ID,
        timestamp: 1700000000000,
        adUnits: {},
      });
      expect(report.gdpr).to.equal(1);
      expect(report.gdprConsent).to.equal('consent-string');
    });

    it('omits consent fields when no consent data is present', () => {
      const report = buildAuctionReport({
        auctionId: AUCTION_ID,
        timestamp: 1700000000000,
        adUnits: {},
      });
      expect(report).to.not.have.property('gdpr');
      expect(report).to.not.have.property('usPrivacy');
      expect(report.pbjsVersion).to.exist;
    });
  });
});
