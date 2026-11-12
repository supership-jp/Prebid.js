# Overview

```txt
Module Name: AdGeneration Analytics Adapter
Module Type: Analytics Adapter
Maintainer:  ssp-dev@supership.jp
```

#### About

This analytics adapter collects the bidding results of ad units that include an
AdGeneration (`adgeneration`, or one of its aliases) bid request, and sends them
to AdGeneration's analytics endpoint. For each such ad unit it reports the
status of every bidder (cpm / currency / response time / media type / size), so
AdGeneration can compare its results with the other bidders.

Which ad units are sent is decided per AdGeneration bid request, by hashing its
`bidId` (see [Sampling](#sampling)). Nothing is sent unless both `endpoint` and
`ratio` are configured.

#### Events

Each request body carries page-level values once, and an `events` array:

```json
{
  "v": 1,
  "analyticsVersion": "2.0.0",
  "pbjsVersion": "11.44.0",
  "page": "https://example.com/article/1",
  "events": [
    {
      "type": "auctionEnd",
      "ts": 1794386087018,
      "bidId": "6f1c2d3e-...",
      "auctionId": "a1b2c3",
      "adUnitCode": "div-1",
      "data": {
        "bidders": {
          "adgeneration": { "status": "noBid" },
          "appnexus": { "status": "bid", "bids": [{ "adId": "x1", "cpm": 0.42, "currency": "JPY", "timeToRespond": 210 }] }
        }
      }
    }
  ]
}
```

- `bidId` is the `bidId` of the AdGeneration bid request for that ad unit (the
  same value as `imp.id` in the request sent to AdGeneration). It is available
  even when AdGeneration times out.
- Consent data (`gdpr`, `gdprConsent`, `usPrivacy`, `gpp`, `gppSid`, `coppa`) is
  added to the top level when available.

| `type`           | Sent on            | `data` |
|------------------|--------------------|--------|
| `auctionEnd`     | `AUCTION_END`      | `bidders`: status of every bidder of the ad unit. `status` is `requested`, `bid`, `noBid`, `timeout` or `rejected`. A successful `BID_RESPONSE` always wins over the other statuses. Successful responses are collected in `bids`, rejected responses (with their `reason`) in `rejectedBids`. |
| `bidWon`         | `BID_WON`          | `bidder` and the bid fields (`adId`, `cpm`, ...). |
| `adRenderFailed` | `AD_RENDER_FAILED` | `adId`, `reason`, `message`. |
| `viewable`       | `BID_VIEWABLE`     | `adId`, `bidder`, `mediaType`. |

Follow-up events (`bidWon`, `adRenderFailed`, `viewable`) are sent only for ad
units that were sent on `AUCTION_END`, for the latest 50 auctions.

#### Batching

Events are queued and sent together:

- The first queued event starts a timer of `batchDelay` ms (1000 by default).
  When it fires, every queued event is sent in one request. Later events do not
  extend the wait; the next event after sending starts a new timer.
- If adding an event would make the body larger than 60KB, the queued events are
  sent first.
- When the page becomes hidden (`visibilitychange`) or is unloaded
  (`pagehide`), the queued events are sent immediately.

Requests are sent with `navigator.sendBeacon()`; if it is unavailable the
adapter falls back to an `ajax` POST with `keepalive`. The body is JSON sent as
`text/plain` to avoid a CORS preflight.

#### Sampling

An AdGeneration bid request is sent when

```txt
fnv1a32(bidId) % 10000 < round(ratio * 10000)
```

where `fnv1a32` is FNV-1a 32bit over the UTF-8 bytes of `bidId`. The receiver can
reproduce the decision from the `bidId`, so the ad units that were not sent can
also be counted.

Do not use the analytics base option `sampling` (a per-session random draw) with
this adapter; it is ignored with a warning, because it would make the decision
impossible to reproduce from the `bidId`.

#### Known limitations

- The `auctionEnd` event is a snapshot taken at `AUCTION_END`. Bid responses
  that arrive after `AUCTION_END` are not included, because the core still emits
  `BID_RESPONSE` for late responses that come in after the auction timeout.
  Such bidders are reported with the status `timeout`.
- If an ad unit has two or more AdGeneration bid requests (for example with
  different params), one event is sent per selected `bidId`, and they share the
  same bidder entry in `bidders`.

#### Viewability

The `BID_VIEWABLE` event is not emitted by the analytics adapter on its own. To
collect viewability data, include and enable one of the viewability modules:

- `bidViewabilityIO` — uses the browser `IntersectionObserver`. No ad server
  required. Banner only.
- `bidViewability` — uses GPT's `impressionViewable` event. Requires GAM + GPT.
  Banner / Outstream / Native.

```js
pbjs.setConfig({ bidViewabilityIO: { enabled: true } });
```

#### Analytics Options

| Name         | Scope    | Example                               | Type     | Description |
|--------------|----------|---------------------------------------|----------|-------------|
| `endpoint`   | required | `https://d.socdm.com/adgen/analytics` | `string` | Endpoint that receives the events. Must be `https` on `socdm.com` or `scaleout.jp` (or their subdomains). Nothing is sent without it. |
| `ratio`      | required | `0.1`                                 | `number` | Ratio of AdGeneration bid requests to send, between `0` and `1`. Defaults to `0` (nothing is sent). |
| `batchDelay` | optional | `1000`                                | `number` | Time in ms to wait from the first queued event before sending, between `0` and `5000`. Defaults to `1000`. `0` sends every event immediately. |

#### Build

```sh
gulp build --modules=adgenerationBidAdapter,adgenerationAnalyticsAdapter,bidViewabilityIO
```

#### Example Configuration

```js
pbjs.enableAnalytics({
    provider: 'adgeneration',
    options: {
        endpoint: 'https://d.socdm.com/adgen/analytics',
        ratio: 0.1,
        /**
         * [optional] Defaults to 1000.
         */
        batchDelay: 1000
    }
});
```
