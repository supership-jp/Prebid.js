export interface AdgenerationAnalyticsAdapterOptions {
  /**
   * Endpoint that receives the events. Must be https on socdm.com or
   * scaleout.jp (or their subdomains). Nothing is sent without it.
   */
  endpoint: string;

  /**
   * Ratio of AdGeneration bid requests to send, between 0 and 1.
   * Decided by `fnv1a32(bidId) % 10000 < round(ratio * 10000)`. Defaults to 0.
   */
  ratio: number;

  /**
   * Milliseconds to wait from the first queued event before sending,
   * between 0 and 5000. Defaults to 1000. 0 sends every event immediately.
   */
  batchDelay?: number;
}

declare module '../libraries/analyticsAdapter/AnalyticsAdapter' {
  interface AnalyticsProviderConfig {
    adgeneration: {
      options: AdgenerationAnalyticsAdapterOptions
    }
  }
}
