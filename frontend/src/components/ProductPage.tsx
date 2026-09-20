import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { dateTime, inr, INTERVALS, intervalLabel, timeAgo, timeUntil } from '../format';
import type { HistoryPoint, Product, Stats } from '../types';
import { Chart } from './Chart';
import { ScrapeLog } from './ScrapeLog';
import { ErrorNote, OutcomeBadge, Spinner, Stat, useInterval } from './ui';

export function ProductPage({ id }: { id: number }) {
  const [product, setProduct] = useState<Product | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [history, setHistory] = useState<HistoryPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'chart' | 'table'>('chart');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [logKey, setLogKey] = useState(0);

  const load = useCallback(async () => {
    try {
      const [p, h] = await Promise.all([api.product(id), api.history(id)]);
      setProduct(p.product);
      setStats(p.stats);
      setHistory(h);
      setError(null);
      setLogKey((k) => k + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => void load(), [load]);
  // Poll faster while waiting for the very first reading.
  useInterval(() => void load(), product && product.readings === 0 ? 8000 : 30000);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg(ok);
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (error && !product) {
    return (
      <>
        <a className="back" href="#/">
          ← All products
        </a>
        <ErrorNote message={error} onRetry={() => void load()} />
      </>
    );
  }
  if (!product || !history) return <Spinner label="Loading product…" />;

  const p = product;
  const now = Date.now();
  const rate = stats?.runSuccessRate;

  return (
    <>
      <a className="back" href="#/">
        ← All products
      </a>

      <header className="pp-head">
        <div>
          <h1>{p.name}</h1>
          <p className="muted">
            {p.brand} · {p.category} · SKU {p.sku} · store id #{p.storeProductId}
          </p>
        </div>
        <OutcomeBadge outcome={p.lastOutcome} />
      </header>

      <div className="stats">
        <Stat
          label="Current price"
          value={<span className="price">{inr(p.lastPrice)}</span>}
          hint={p.mrp ? `MRP ${inr(p.mrp)}${p.discountPct ? ` · ${p.discountPct}% below MRP` : ''}` : undefined}
        />
        <Stat
          label="Stock"
          value={p.lastStock === null ? '—' : p.lastStock === 0 ? 'Out of stock' : `${p.lastStock} units`}
          hint={`Last good reading ${timeAgo(p.lastSuccessAt, now)}`}
        />
        <Stat label="Lowest / highest seen" value={`${inr(p.lowPrice)} / ${inr(p.highPrice)}`} hint={`${p.readings} reading${p.readings === 1 ? '' : 's'}`} />
        <Stat
          label="Rating"
          value={p.rating ? `${p.rating.toFixed(1)} ★` : '—'}
          hint={p.ratingCount ? `${p.ratingCount.toLocaleString('en-IN')} ratings${p.seller ? ` · ${p.seller}` : ''}` : p.seller ?? undefined}
        />
        <Stat
          label="Scrape reliability"
          value={rate === null || rate === undefined ? '—' : `${Math.round(rate * 100)}% of runs`}
          hint={stats ? `${stats.successes} ok · ${stats.retried} retried · ${stats.failed} failed attempts` : undefined}
        />
        <Stat label="Next scrape" value={p.active ? timeUntil(p.nextDueAt, now) : 'Paused'} hint={`Every ${intervalLabel(p.intervalMinutes)}`} />
      </div>

      <div className="actions">
        <button className="btn btn-primary" disabled={busy} onClick={() => void act(() => api.scrapeNow(id), 'Scrape started. The log below updates as it runs.')}>
          Scrape now
        </button>
        <button className="btn" disabled={busy} onClick={() => void act(() => api.update(id, { active: !p.active }))}>
          {p.active ? 'Pause tracking' : 'Resume tracking'}
        </button>
        <label className="interval">
          <span className="muted small">Frequency</span>
          <select
            className="input input-small"
            value={p.intervalMinutes}
            disabled={busy}
            onChange={(e) => void act(() => api.update(id, { intervalMinutes: Number(e.target.value) }), 'Frequency updated.')}
          >
            {INTERVALS.map((i) => (
              <option key={i.value} value={i.value}>
                {i.label}
              </option>
            ))}
          </select>
        </label>
        <button
          className="btn btn-danger"
          disabled={busy}
          onClick={() => {
            if (confirm(`Stop tracking “${p.name}” and delete its history?`)) {
              void act(async () => {
                await api.remove(id);
                location.hash = '#/';
              });
            }
          }}
        >
          Stop tracking
        </button>
        {msg ? <span className="muted small" role="status">{msg}</span> : null}
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Price &amp; stock history</h2>
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'chart'} className={tab === 'chart' ? 'tab on' : 'tab'} onClick={() => setTab('chart')}>
              Chart
            </button>
            <button role="tab" aria-selected={tab === 'table'} className={tab === 'table' ? 'tab on' : 'tab'} onClick={() => setTab('table')}>
              Table
            </button>
          </div>
        </div>
        {history.length === 0 ? (
          <p className="muted">
            No successful readings yet. A failed scrape never writes a price, so this stays empty until one succeeds; see the log below for what happened.
          </p>
        ) : tab === 'chart' ? (
          <div className="charts">
            <h3>Price (₹)</h3>
            <Chart points={history} field="price" />
            <h3>Stock (units)</h3>
            <Chart points={history} field="stock" height={160} color="var(--accent-2)" stepped />
          </div>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Scraped at</th>
                  <th>Price</th>
                  <th>Stock</th>
                  <th>MRP</th>
                  <th>Below MRP</th>
                  <th>Deal price</th>
                </tr>
              </thead>
              <tbody>
                {[...history].reverse().map((h, i) => (
                  <tr key={i}>
                    <td className="nowrap">{dateTime(h.scrapedAt)}</td>
                    <td>{inr(h.price)}</td>
                    <td>{h.stock}</td>
                    <td>{inr(h.mrp)}</td>
                    <td>{h.discountPct === null ? '—' : `${h.discountPct}%`}</td>
                    <td>{inr(h.dealPrice)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ScrapeLog productId={id} refreshKey={logKey} />
    </>
  );
}
