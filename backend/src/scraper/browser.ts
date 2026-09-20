import { chromium, type Browser } from 'playwright';
import { config } from '../config.js';
import { log } from '../log.js';

export interface BrowserOptions {
  headed: boolean;
  /** Milliseconds to pause between Playwright actions so a human can follow along. */
  slowMo?: number;
}

/**
 * Owns one Chromium instance and relaunches it if it crashed or was closed.
 * A fresh BrowserContext is created per attempt (clean cookies/storage), which is
 * far cheaper than a fresh browser and keeps memory low on a 512 MB free tier.
 */
export class BrowserProvider {
  private browser: Browser | null = null;

  constructor(private opts: BrowserOptions) {}

  get headed() {
    return this.opts.headed;
  }

  async get(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (this.browser) log.warn('browser was disconnected; relaunching');
    this.browser = await chromium.launch({
      headless: !this.opts.headed,
      channel: config.browserChannel,
      slowMo: this.opts.slowMo,
      args: [
        '--no-sandbox', // required inside the Render/Docker container
        '--disable-dev-shm-usage', // /dev/shm is tiny in containers
        '--disable-extensions',
        '--disable-background-networking',
      ],
    });
    return this.browser;
  }

  async close() {
    const b = this.browser;
    this.browser = null;
    await b?.close().catch(() => undefined);
  }
}
