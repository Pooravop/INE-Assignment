import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { SearchHit } from '../types';
import { ErrorNote, Spinner } from './ui';

/** Search the store catalogue by partial or full product name and pick something to track. */
export function Search({ onTracked }: { onTracked: () => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const seq = useRef(0);

  // Debounced search; stale responses are ignored.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setHits(null);
      setError(null);
      return;
    }
    const mine = ++seq.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await api.search(term);
        if (mine === seq.current) {
          setHits(r.results);
          setError(null);
        }
      } catch (e) {
        if (mine === seq.current) setError((e as Error).message);
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const track = async (hit: SearchHit) => {
    setBusy(hit.id);
    try {
      const r = await api.track(hit.id);
      setHits((h) => h?.map((x) => (x.id === hit.id ? { ...x, tracked_id: r.product.id } : x)) ?? h);
      onTracked();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card search">
      <div className="card-head">
        <h2>Find a product to track</h2>
      </div>
      <label className="sr-only" htmlFor="q">
        Search products
      </label>
      <input
        id="q"
        className="input"
        type="search"
        placeholder="Search by full or partial name, e.g. “nordkraft headphones” or “monitor”"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoComplete="off"
      />
      {error ? <ErrorNote message={error} /> : null}
      {loading && !hits ? <Spinner label="Searching…" /> : null}
      {hits && hits.length === 0 ? <p className="muted">No products match “{q.trim()}”.</p> : null}
      {hits && hits.length > 0 ? (
        <ul className="results">
          {hits.map((h) => (
            <li key={h.id} className="result">
              <div className="result-main">
                <div className="result-name">{h.name}</div>
                <div className="muted small">
                  {h.brand} · {h.category} · SKU {h.sku}
                </div>
              </div>
              {h.tracked_id ? (
                <a className="btn btn-small" href={`#/product/${h.tracked_id}`}>
                  Tracked · view
                </a>
              ) : (
                <button className="btn btn-primary btn-small" disabled={busy === h.id} onClick={() => void track(h)}>
                  {busy === h.id ? 'Adding…' : 'Track'}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
