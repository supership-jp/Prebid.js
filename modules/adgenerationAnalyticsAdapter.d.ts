export interface AdgenerationAnalyticsAdapterOptions {
  /**
   * URL of the config file that holds the endpoint, the ratio and the batch
   * delay. Must be https. Defaults to AdGeneration's production config file.
   * Set it only to point at a test config file.
   */
  configUrl?: string;
}

/**
 * Content of the config file (version 1).
 */
export interface AdgenerationAnalyticsConfig {
  /**
   * Format version of the config file. Only 1 is supported.
   */
  v: 1;

  /**
   * Endpoint that receives the events. Must be https on socdm.com or
   * scaleout.jp (or their subdomains). Nothing is sent without it.
   */
  endpoint: string;

  /**
   * Ratio of AdGeneration bid requests to send, between 0 and 1.
   * Decided by `fnv1a32(bidId) % 10000 < round(ratio * 10000)`.
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
