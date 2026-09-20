-- Product Price Tracker schema. Idempotent: safe to run on every boot.
-- Paste into the Supabase SQL editor, or let the API apply it on startup.

-- Local cache of the store catalogue (the store has no search endpoint and
-- randomises catalogue order on every request, so we crawl once and search here).
create table if not exists catalog_products (
  id          integer primary key,             -- the store's own product id
  slug        text not null,
  name        text not null,
  brand       text not null default '',
  category    text not null default '',
  sku         text not null default '',
  description text not null default '',
  fetched_at  timestamptz not null default now()
);
create index if not exists catalog_products_name_idx on catalog_products (lower(name));

-- Products the user chose to track.
create table if not exists tracked_products (
  id                   bigserial primary key,
  store_product_id     integer not null unique,
  slug                 text not null default '',
  name                 text not null,
  brand                text not null default '',
  category             text not null default '',
  sku                  text not null default '',
  description          text not null default '',
  interval_minutes     integer not null default 120 check (interval_minutes between 15 and 10080),
  active               boolean not null default true,
  created_at           timestamptz not null default now(),
  last_attempt_at      timestamptz,             -- when the newest scrape run started (any outcome)
  last_success_at      timestamptz,
  consecutive_failures integer not null default 0,
  last_price           numeric(12,2),           -- denormalised copy of the newest good reading
  last_stock           integer
);

-- One row per SUCCESSFUL scrape. Failures never write here, so this table can
-- never contain empty or guessed data.
create table if not exists price_history (
  id           bigserial primary key,
  product_id   bigint not null references tracked_products(id) on delete cascade,
  scraped_at   timestamptz not null default now(),
  price        numeric(12,2) not null check (price > 0),
  mrp          numeric(12,2),
  deal_price   numeric(12,2),
  discount_pct integer,
  stock        integer not null check (stock >= 0),
  rating       numeric(3,2),
  rating_count integer,
  seller       text,
  run_id       uuid not null
);
create index if not exists price_history_product_time_idx on price_history (product_id, scraped_at desc);

-- One row per scrape ATTEMPT (success, retried, failed). Written as 'running'
-- before the attempt starts so a crash cannot leave a silent gap.
create table if not exists scrape_log (
  id           bigserial primary key,
  run_id       uuid not null,                   -- groups the attempts of one scrape run
  product_id   bigint not null references tracked_products(id) on delete cascade,
  attempt      integer not null,
  max_attempts integer not null,
  trigger      text not null default 'cron',    -- cron | manual | track
  started_at   timestamptz not null default now(),
  duration_ms  integer,
  outcome      text not null check (outcome in ('running','success','retried','failed')),
  error_code   text,
  message      text,
  price        numeric(12,2),
  stock        integer
);
create index if not exists scrape_log_product_time_idx on scrape_log (product_id, started_at desc);

-- In-app alerts (price drop, back in stock, store structure change).
create table if not exists alerts (
  id         bigserial primary key,
  product_id bigint references tracked_products(id) on delete cascade,
  kind       text not null check (kind in ('price_drop','back_in_stock','out_of_stock','structure_change')),
  message    text not null,
  old_value  numeric(12,2),
  new_value  numeric(12,2),
  created_at timestamptz not null default now()
);
create index if not exists alerts_created_idx on alerts (created_at desc);

-- Single-row-per-name lease so overlapping cron triggers cannot double-scrape.
create table if not exists scrape_lock (
  name         text primary key,
  holder       text not null,
  locked_until timestamptz not null
);
