import { useEffect, useState } from 'react';
import { dateTime, inr, timeAgo, timeUntil } from '../format';
import type { Alert, Product } from '../types';
import { ErrorNote, OutcomeBadge, Spinner } from './ui';

function Delta({ now, prev }: { now: number | null; prev: number | null }) {
  if (now === null || prev === null || now === prev) return null;
  const pct = ((now - prev) / prev) * 100;
  const down = now < prev;
  return (
    <span className={`delta ${down ? 'delta-down' : 'delta-up'}`} title={`Previous reading ${inr(prev)}`}>
      {down ? '▼' : '▲'} {Math.abs(pct).toFixed(1)}%
    </span>
  );
}

function StockChip({ stock }: { stock: number | null }) {
  if (stock === null) return <span className="badge badge-muted">Stock unknown</span>;
  if (stock === 0) return <span className="badge badge-failed">Out of stock</span>;
  return <span className="badge badge-success">{stock} in stock</span>;
}

function ProductCard({ p, now }: { p: Product; now: number }) {
  return (
    <a className={`product-card ${p.active ? '' : 'is-paused'}`} href={`#/product/${p.id}`}>
      <div className="pc-top">
        <div>
          <div className="pc-name">{p.name}</div>
          <div className="muted small">
            {p.brand} · {p.category}
          </div>
        </div>
        <OutcomeBadge outcome={p.lastOutcome} />
      </div>
      <div className="pc-price">
        <span className="price">{inr(p.lastPrice)}</span>
        <Delta now={p.lastPrice} prev={p.prevPrice} />
      </div>
      <div className="pc-row">
        <StockChip stock={p.lastStock} />
        {p.mrp && p.lastPrice ? <span className="muted small">MRP {inr(p.mrp)}</span> : null}
      </div>
      <div className="pc-foot muted small">
        <span>Last good reading {timeAgo(p.lastSuccessAt, now)}</span>
        <span>{p.active ? `Next scrape ${timeUntil(p.nextDueAt, now)}` : 'Paused'}</span>
      </div>
      {p.consecutiveFailures > 0 ? (
        <div className="pc-warn small">
          {p.consecutiveFailures} failed run{p.consecutiveFailures === 1 ? '' : 's'} in a row
          {p.lastError ? ` — ${p.lastError.slice(0, 90)}` : ''}
        </div>
      ) : null}
    </a>
  );
}

const ALERT_ICON: Record<Alert['kind'], string> = {
  price_drop: '▼',
  back_in_stock: '✓',
  out_of_stock: '✕',
  structure_change: '⚠',
};

export function Alerts({ alerts }: { alerts: Alert[] }) {
  if (alerts.length === 0) return null;
  return (
    <section className="card">
      <div className="card-head">
        <h2>Recent alerts</h2>
      </div>
      <ul className="alerts">
        {alerts.slice(0, 6).map((a) => (
          <li key={a.id} className={`alert alert-${a.kind}`}>
            <span className="alert-icon" aria-hidden>
              {ALERT_ICON[a.kind]}
            </span>
            <span className="alert-text">{a.message}</span>
            <span className="muted small nowrap">{dateTime(a.createdAt)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Dashboard({ products, loading, error, reload, alerts }: {
  products: Product[] | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
  alerts: Alert[];
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  return (
    <>
      <Alerts alerts={alerts} />
      <section>
        <div className="section-head">
          <h2>Tracked products {products ? <span className="muted">({products.length})</span> : null}</h2>
        </div>
        {error ? <ErrorNote message={error} onRetry={reload} /> : null}
        {loading && !products ? <Spinner label="Loading tracked products…" /> : null}
        {products && products.length === 0 ? (
          <div className="card empty">
            <p>
              <strong>Nothing tracked yet.</strong>
            </p>
            <p className="muted">Search for a product above and press Track. The first price reading is taken right away.</p>
          </div>
        ) : null}
        <div className="grid">
          {products?.map((p) => (
            <ProductCard key={p.id} p={p} now={now} />
          ))}
        </div>
      </section>
    </>
  );
}

