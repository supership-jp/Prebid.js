# Overview

```txt
Module Name: AdGeneration Analytics Adapter
Module Type: Analytics Adapter
Maintainer:  ssp-dev@supership.jp
```

#### About

This analytics adapter collects, per auction, the bidding performance of all
bidders participating in your ad units (cpm / currency / response time / media
type / size / win) and sends it to AdGeneration's analytics endpoint. The data
is aggregated per auction and sent on `AUCTION_END`, while `BID_WON`,
`BID_VIEWABLE` and ad render results are sent individually as follow-up events.

Within the auction report, each bidder entry carries a `status` of
`requested`, `bid`, `noBid`, `timeout` or `rejected`. A successful
`BID_RESPONSE` always wins over the other statuses. Because a single bidder can
respond multiple times (multi-format / multibid), successful responses are
collected in a `bids` array, and rejected responses (with their `reason`) in a
`rejectedBids` array.

Reports are sent with `navigator.sendBeacon()` so they are not lost even when
the page is unloaded; if `sendBeacon` is unavailable the adapter falls back to
an `ajax` POST.

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

| Name       | Scope    | Example                                    | Type     | Description |
|------------|----------|--------------------------------------------|----------|-------------|
| `endpoint` | optional | `https://d.socdm.com/adgen/analytics`      | `string` | Endpoint that receives the analytics reports. Defaults to the AdGeneration production endpoint. |
| `sampling` | optional | `1.0`                                      | `float`  | Sampling rate between `0.0` and `1.0`. Data is collected only on this ratio of browser sessions (handled by the analytics base). |

#### Build

```sh
gulp build --modules=adgenerationBidAdapter,adgenerationAnalyticsAdapter,bidViewabilityIO
```

#### Example Configuration

```js
pbjs.enableAnalytics({
    provider: 'adgeneration',
    options: {
        /**
         * Endpoint that receives the analytics reports.
         * [optional] Defaults to the AdGeneration production endpoint.
         */
        endpoint: 'https://d.socdm.com/adgen/analytics',
        /**
         * Sampling rate between 0.0 and 1.0.
         * [optional]
         */
        sampling: 1.0
    }
});
```
