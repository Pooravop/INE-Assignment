# Design note

## What makes this store hard

Found by reading the site's network traffic and page code before writing any scraper:

- The page is a client-rendered SPA. The HTML is an empty `<div id="root">`; **plain HTML parsing sees nothing.**
- Catalogue and product metadata are ordinary JSON (`/api/catalog`, `/api/product/:id`). **Price and stock are not.** They appear only after a "Reveal price" button that stays disabled until the pointer has moved over the price area, and the click must be a real (trusted) one. The store then makes a session call that it can reject (`POST /api/session → 401 unauthorized`).
- The rendered price is disguised: two **hidden decoy prices** (`.price-value`, `[data-price]`, `display:none`), a struck-through MRP, sometimes a "Deal price" line, and seven number formats (`₹1,23,456`, `₹1 23 456`, `₹1.23.456,00`, `…/- (incl. of all taxes)`, fullwidth digits, non-breaking/zero-width characters between every glyph, `Rs. 1,23,456.00`). A layout API changes element classes and order between revisions.
- Noise: ~35% of clicks are silently swallowed or delayed, a cookie dialog can appear at a random moment and block clicks, prices sometimes show a provisional "Updating…" state, product calls return 429/5xx, and the catalogue **re-shuffles on every request**.

## Decision: lightweight where possible, browser where required

| Data | Method | Why |
|---|---|---|
| Search, product metadata | Plain `fetch` on the JSON API, cached in Postgres | No JS needed; fast; cheap |
| Price, stock | Playwright driving the real page | The store genuinely requires a browser here |

I deliberately did **not** reverse-engineer or replay the store's session/challenge protocol over HTTP. It would be faster, but it means defeating an anti-automation check by imitation, and it would break on any change. The scraper instead does what a user does (hover, press) and reads what the page shows.

## How the scraper stays reliable

1. **Two independent extractions must agree.** Structural (the one visible, non-struck-through element with the largest font) and marker (the element carrying the class the store's own `/api/layout` names). Disagreement throws `PRICE_CONFLICT`; nothing is guessed. Hidden decoys and the MRP can never be selected.
2. **Validate, then store.** Positive finite price, non-negative integer stock, price ≤ MRP. A reading that jumps more than 3× from the last good one must be **confirmed by a second read** before it is trusted.
3. **A failure writes no price, ever.** `price_history` only receives validated readings, so charts show gaps rather than fabricated points.
4. **Honest log, written ahead.** Each attempt is inserted as `running` *before* it starts, then set to `success` / `retried` / `failed` with a stable error code and the store's own error text. If the process dies mid-attempt, the next boot converts the orphan to `failed / INTERRUPTED`: no silent gaps.
5. **Retries with backoff and jitter** (6 attempts, 2 s → 30 s), each in a fresh browser context. Non-retryable errors (product 404) stop immediately. A 75 s watchdog closes a hung page.
6. **Handles the noise explicitly:** swallowed clicks are detected (no state change within 2.5 s) and re-clicked; the cookie dialog is dismissed by a Playwright locator handler; "Updating…" prices trigger Refresh instead of being stored.
7. **Scheduling fits the free tier.** No always-on loop. cron-job.org calls `/api/cron/scrape`; the API answers `202` immediately (cron services give up after ~30 s) and scrapes in the background. A DB lease lock stops overlapping triggers; a 10-minute grace window on the "due" check stops an early trigger from skipping a cycle; a 10-minute `/health` ping keeps the instance awake.
8. **Change detection.** Missing price block, ambiguous price element, or no stock statement raises `STRUCTURE_CHANGED` and a de-duplicated in-app alert.

## Measured results (single attempts, real Chrome, human-like input, Windows dev machine)

| Mode | Passed the store's session check | Note |
|---|---|---|
| Headless | 8 / 28 (29%) | two batches, different products |
| Headed | 11 / 20 (55%) | same machine |

Per-product results were only partly repeatable (10 of 14 products gave the same result in two separate runs), so some products are harder than others and some flip between attempts. With 6 attempts and independent tries, 55% per attempt would be ≈99% per run and 29% ≈88%, but independence is an assumption the data only partly supports, and **I have not measured Linux/Xvfb on Render**. That is why the log, not a claim, is the source of truth. Reproduce with `npm run diag:sample -- <ids>` in `backend/`.

Default is therefore *headed whenever a display exists* (Xvfb in Docker).

## Trade-offs

- **Reliability vs. cost.** Real browser + retries is slower and heavier than HTTP (≈10–20 s per attempt, measured; Chromium's memory footprint on a 512 MB instance is the open concern). Chosen because it is the only approach that reads the price honestly. Worst case per product ≈ 3 minutes.
- **Headed-in-Docker vs. memory.** Headed passes more often but uses more RAM than headless on a 512 MB instance; a GitHub Actions fallback runner is provided.
- **Strict validation vs. completeness.** The jump-confirmation rule can delay a genuine large price change by one read. I preferred that to storing a glitch.
- **Gaps over guesses.** A failed run leaves a gap in the chart.
- **No accounts.** Fine for a demo; a public deployment would need auth and rate limiting.

## What the AI assistant got wrong first, and how it was corrected

1. **Assumed plain HTTP + HTML parsing would do.** It found an empty SPA shell. Corrected by inspecting the bundle and traffic, then splitting the work as above.
2. **Assumed catalogue paging was stable.** One full crawl returned only 650 of 1000 products because order re-shuffles per request. Fixed with repeated passes plus a by-id gap-fill. The first gap-fill ran 6 requests in parallel, hit HTTP 429, and left the catalogue at **902/1000 while still reporting a successful sync** (only log warnings); fixed with sequential passes, `Retry-After` handling and 2 workers (now 1000/1000), and a warning when incomplete.
3. **First mouse simulation failed every time.** Evenly timed jumps between random points plus Playwright's instant `click()` got `challenge_failed`. Replaced with curved, eased movement at ~60 Hz and a real down/up press. The Refresh button had the same flaw and was fixed separately after a run exposed it.
4. **A regex bug picked "2% off" as the price.** JS `/\d/` does not match fullwidth digits, so the real price element was filtered out before normalisation. Found by a 16-product batch, fixed by normalising first, and locked in with a test.
5. **Invented a validation rule that rejected good data.** It required the "N% off" badge to match price/MRP. Repeated reads of one product (same price and MRP) showed the badge at 45, 45, 45, 35 and 48, so the badge is noise. Rule removed; discount is computed from price and MRP.
6. **Over-read a small sample.** After 6 headed attempts it claimed "~83% headed vs ~29% headless" and wrote that into a code comment. More data gave 55%; the comment and this note use the larger sample.
7. **A hypothesis that did not pan out.** A slower, more deliberate pointer profile gave 6/14, identical to the normal profile on the same products, so it was reverted rather than kept as cargo.
8. **Smaller ones:** `page.evaluate(string)` evaluates but does not call a function string (returned `undefined`); a dangling watchdog timer per attempt; a "1 h 60 min" countdown; duplicate integer ticks on the stock axis.

## Not done / next

Email alerts via SendGrid; authentication; per-product headed/headless learning (choose the mode that passes more for that product); live measurement of Render/Xvfb pass rate.
