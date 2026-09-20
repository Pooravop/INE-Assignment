# Product Price Tracker

Pick a product from INE's mock store, and the app scrapes its **price and stock every 2 hours**, keeps the history, and shows a **per-attempt scrape log** that records failures honestly.

| | |
|---|---|
| **Live site** | Vercel URL here_ |
| **API** | Render URL here_ |
| **Design note** | [DESIGN_NOTE.md](DESIGN_NOTE.md) |

## What it does

1. **Search** the store by full or partial product name (`nordkraft head`, `monitor`, a SKU…) and **track** a product. Tracked products persist in Supabase.
2. **Scrape on a schedule.** cron-job.org calls the API every 2 hours; the API scrapes every due product with retries, then goes back to sleep.
3. **History.** Price and stock over time as a chart or a table, plus MRP, discount, rating and seller.
4. **Scrape log.** Every attempt with timestamp, duration and outcome (`success`, `retried`, `failed`) and the actual error. A failed scrape never writes a price.

Bonus items included: in-app alerts (price drop, back in stock, out of stock, page-structure change), a multi-product dashboard, configurable frequency per product, and GitHub Actions CI.

## Architecture

```
 cron-job.org ── every 2 h ──▶  POST /api/cron/scrape  (Bearer CRON_SECRET)
 (+ /health every 10 min                │  replies 202 immediately
   to keep Render awake)                ▼
                              ┌──────────────────────┐
  Vercel (React) ── /api ───▶ │  Express API (Render)│
                              │  ├─ runner: lock, due │──▶ Playwright (Chromium)
                              │  │   check, retries   │       └─▶ INE mock store
                              │  └─ catalogue search  │──▶ store JSON API (plain fetch)
                              └──────────┬───────────┘
                                         ▼
                                Supabase (PostgreSQL)
                    tracked_products · price_history · scrape_log
                    alerts · catalog_products · scrape_lock
```

**Lightweight vs headless.** Catalogue and product metadata come from the store's JSON endpoints with a plain HTTP client. The *price and stock* cannot: the store reveals them only after a real hover-and-click in a real browser, so that part (and only that part) uses Playwright. Details in the [design note](DESIGN_NOTE.md).

## Scraping schedule

| Job | Where | Schedule |
|---|---|---|
| Scrape all due products | cron-job.org → `POST {API}/api/cron/scrape` | `0 */2 * * *` (every 2 hours) |
| Keep the API warm | cron-job.org → `GET {API}/health` | every 10 minutes |

A product is *due* once `interval − 10 min` has passed since its last attempt began (default interval 120 min; the 10-minute grace stops a trigger that fires slightly early from skipping a whole cycle). To use per-product frequencies shorter than 2 hours, make the cron job fire more often (e.g. every 30 min); the due check decides who actually gets scraped.

## Run it locally

Needs Node 20+ and Google Chrome (or run `npx playwright install chromium`).

```bash
# 1. backend  (no database needed locally: it falls back to an embedded Postgres)
cd backend
npm install
cp .env.example .env          # then set USE_PGLITE=1, CRON_SECRET, and BROWSER_CHANNEL=chrome (see below)
npm run dev                   # http://localhost:8080

# 2. frontend (separate terminal)
cd frontend
npm install
npm run dev                   # http://localhost:5173  (proxies /api to :8080)
```

`BROWSER_CHANNEL=chrome` (in `.env`) drives your installed Chrome. Leave it unset to use Playwright's bundled Chromium, which `npm install` downloads (~200 MB; it fails silently if the disk is full).

### Watch the scraper (headed run)

```bash
cd backend
npm run demo                              # headed run with injected faults (about a minute)
npm run scrape:headed -- --product 7      # headed run for one store product id (tracks it if new)
npm run scrape -- --all                   # run everything that is due
```

`npm run demo` opens a visible browser at natural speed and narrates every step in the terminal. It uses `--chaos`, which makes our own browser see a **slow store API and HTTP 503 on the first two attempts**, so you can watch the retry-with-backoff recover and then see the honest scrape log printed at the end. This is the run to screen-record; for a 2–4 minute video also show the dashboard, a product's chart and the scrape log in the UI, and (optionally) a second run such as `npm run scrape:headed -- --product 17`.

Useful flags: `--headed`, `--product <id>`, `--all`, `--force`, `--chaos`, `--attempts <n>`. (`--slow-mo` exists but is best avoided: Playwright delays every mouse-move step, which distorts the pointer timing the store measures.)

### Tests

```bash
cd backend && npm test        # 79 tests, ~10 s, no network and no browser
```

They run against an embedded Postgres with a scripted fake scraper and cover: retries and log outcomes, never storing bad data, price-jump confirmation, the due window, overlap locking, crash reconciliation, alerts, the watchdog, and all seven price formats the store renders.

## Environment variables

### Backend (`backend/.env`, or Render dashboard)

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | prod | – | Supabase **Session pooler** connection string |
| `USE_PGLITE` | dev | – | `1` = embedded Postgres instead of `DATABASE_URL` |
| `CRON_SECRET` | prod | – | Shared secret cron-job.org sends as `Authorization: Bearer …`. The cron endpoint refuses all calls if unset |
| `CORS_ORIGIN` | prod | `*` | Allowed browser origin(s), comma-separated (your Vercel URL) |
| `PORT` | no | `8080` | |
| `STORE_BASE_URL` | no | `https://demo.inelabteamdev.com` | |
| `SCRAPE_MAX_ATTEMPTS` | no | `6` | Attempts per product per run before it is recorded as failed |
| `SCRAPE_CONCURRENCY` | no | `1` | Products scraped in parallel (keep 1 on 512 MB) |
| `SCRAPE_HEADED` | no | auto | Unset = headed when a display exists (Windows/macOS/Xvfb), else headless. `1`/`0` force it |
| `SCRAPE_ATTEMPT_TIMEOUT_MS` | no | `75000` | Hard ceiling for one attempt |
| `DEFAULT_INTERVAL_MINUTES` | no | `120` | Interval for newly tracked products |
| `BROWSER_CHANNEL` | no | – | `chrome`/`msedge` to use an installed browser locally |

### Frontend (Vercel)

| Variable | Purpose |
|---|---|
| `VITE_API_URL` | Base URL of the Render API, no trailing slash |

## Deploy (all free tiers)

**1. Supabase.** Create a project. *Project Settings → Database → Connection string → **Session pooler***; copy it as `DATABASE_URL`. The API creates its tables on first boot; to do it by hand, paste [`backend/sql/schema.sql`](backend/sql/schema.sql) into the SQL editor.

**2. Render.** *New → Blueprint →* select this repo (it reads [`render.yaml`](render.yaml)). Fill in `DATABASE_URL` and `CORS_ORIGIN`; `CRON_SECRET` is generated for you (copy it from the dashboard). The image is [`backend/Dockerfile`](backend/Dockerfile): Playwright's official image plus Xvfb, so Chromium can run *headed* in the container.

**3. Vercel.** Import the repo, set **Root Directory = `frontend`**, add `VITE_API_URL`. Then put the Vercel URL into Render's `CORS_ORIGIN`.

**4. cron-job.org.** Create two jobs:

- *Scrape*: URL `https://<api>.onrender.com/api/cron/scrape`, method **POST**, schedule every 2 hours, header `Authorization: Bearer <CRON_SECRET>`, request timeout **60 s** (a sleeping instance takes ~30–50 s to wake; the endpoint itself answers in milliseconds with `202`).
- *Keep warm*: `GET https://<api>.onrender.com/health` every 10 minutes (free instances sleep after 15 idle minutes).

> **If Render's 512 MB is too little for headed Chromium** (see [limitations](#known-limitations)), enable the fallback in [`.github/workflows/scrape-fallback.yml`](.github/workflows/scrape-fallback.yml): it runs the same CLI on GitHub's runners every 2 hours against the same Supabase database. Both can be on at once; the database lock and due check prevent double scraping. Add a `DATABASE_URL` repository secret.

## API

| Method & path | Purpose |
|---|---|
| `GET /health` | Liveness + DB check (keep-warm target) |
| `GET /api/status` | Whether a scrape is running, schedule, catalogue size |
| `GET /api/catalog/search?q=` | Search the store by partial/full name, brand, category or SKU |
| `GET /api/products` | Tracked products with latest reading, low/high, last outcome, next due |
| `POST /api/products` | `{ storeProductId, intervalMinutes? }` track a product (first scrape starts immediately) |
| `GET /api/products/:id` | One product + reliability stats |
| `PATCH /api/products/:id` | `{ intervalMinutes?, active? }` |
| `DELETE /api/products/:id` | Stop tracking and delete its history |
| `GET /api/products/:id/history` | Price & stock readings, oldest first |
| `GET /api/products/:id/log` | Scrape attempts, newest first (`limit`, `offset`) |
| `POST /api/products/:id/scrape` | Scrape now (202; 60 s cooldown) |
| `GET /api/alerts` | Recent price-drop / stock / structure alerts |
| `POST` or `GET /api/cron/scrape` | **Scheduled trigger.** Bearer `CRON_SECRET`. Returns `202` at once, scrapes in the background |

## Project layout

```
backend/
  sql/schema.sql            tables (idempotent; applied on boot)
  src/scraper/
    scrapeOnce.ts           one attempt: open page, reveal price, read DOM (Playwright)
    mouse.ts                natural pointer movement (the store gates its price on it)
    interpret.ts            raw DOM facts -> validated Quote (pure, unit-tested)
    parse.ts                price/stock text parsing (7 formats; pure, unit-tested)
    runner.ts               retries, per-attempt log, lock, due check, validation, alerts
  src/store/                plain-HTTP client + catalogue crawl/search
  src/app.ts, server.ts     Express API
  src/cli.ts                headed/CLI runner
  test/                     79 tests
frontend/src/               React + Vite; SVG chart, dashboard, product page, scrape log
```

## Known limitations

Stated plainly because they matter for judging reliability:

- **The store's session check rejects a share of attempts.** On my dev machine (real Chrome, human-like input) a single attempt passed **~55% headed and ~29% headless**. Retries (6 per run) turn that into a much higher per-run success rate, and every rejected attempt is logged as `retried`/`failed`. Numbers and method are in the [design note](DESIGN_NOTE.md).
- **Not yet measured on Linux/Render.** The figures above are from Windows with a GPU. Headed Chromium under Xvfb in the container uses software rendering and may behave differently. Check the scrape log after the first few cron runs.
- **512 MB is tight** for Chromium + Node. The image caps Node's heap, runs one page at a time, and closes the browser after every run; if Render still OOM-kills it, the interrupted attempt is recorded as `failed / INTERRUPTED` on next boot, and the GitHub Actions fallback is the way out.
- **No user accounts.** Anyone with the URL can track/untrack products (a demo trade-off; the manual-scrape button has a cooldown).
- The Dockerfile and Render/Vercel/Supabase setup were written to spec but **not deployed from this workspace**.

## Submission checklist

- [ ] Live site link (Vercel) at the top of this file
- [ ] Public GitHub repository URL
- [ ] 2–4 min screen recording of `npm run demo`
- [ ] This README + [DESIGN_NOTE.md](DESIGN_NOTE.md)
- [ ] PDF resume
- [ ] Email to sstephen@ine.com, cc ssingh@ine.com, subject `First Round: Software Engineer Intern Assignment - <Your Name>`, by **20 Sep 2026, 11:59 PM IST**
