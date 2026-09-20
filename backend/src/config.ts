import 'dotenv/config';

const int = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
};

export const config = {
  port: int(process.env.PORT, 8080),
  databaseUrl: process.env.DATABASE_URL ?? '',
  usePglite: process.env.USE_PGLITE === '1',
  corsOrigin: process.env.CORS_ORIGIN ?? '*',
  cronSecret: process.env.CRON_SECRET ?? '',
  storeBaseUrl: (process.env.STORE_BASE_URL ?? 'https://demo.inelabteamdev.com').replace(/\/+$/, ''),
  maxAttempts: int(process.env.SCRAPE_MAX_ATTEMPTS, 6),
  concurrency: int(process.env.SCRAPE_CONCURRENCY, 1),
  defaultIntervalMinutes: int(process.env.DEFAULT_INTERVAL_MINUTES, 120),
  /** A product counts as due this many minutes early, so a trigger that fires a
   *  little sooner than N hours after the previous run is not skipped. */
  dueGraceMinutes: 10,
  /**
   * The store's session check passes a real, headed browser more often than a headless one.
   * Measured on the dev machine, single attempts: headed 11/20 (55%), headless 8/28 (29%).
   * So default to headed whenever a display exists (in Docker, Xvfb provides one).
   * SCRAPE_HEADED=0 forces headless, SCRAPE_HEADED=1 forces headed.
   */
  headed:
    process.env.SCRAPE_HEADED !== undefined
      ? process.env.SCRAPE_HEADED === '1'
      : process.platform === 'win32' || process.platform === 'darwin' || Boolean(process.env.DISPLAY),
  /** e.g. 'chrome' or 'msedge' to drive an installed browser instead of Playwright's bundled Chromium. */
  browserChannel: process.env.BROWSER_CHANNEL || undefined,
  /** Hard ceiling for one attempt; a hung page can never stall a run. */
  attemptTimeoutMs: int(process.env.SCRAPE_ATTEMPT_TIMEOUT_MS, 75_000),
  /** Attempts still 'running' after this long belong to a dead process. */
  staleAttemptMinutes: 10,
};

export type Config = typeof config;
