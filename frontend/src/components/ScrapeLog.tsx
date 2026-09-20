import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { dateTime, inr } from '../format';
import type { LogRow } from '../types';
import { ErrorNote, OutcomeBadge, useInterval } from './ui';

const PAGE = 15;

/** Every scrape attempt with its real outcome. Failures are shown, never hidden. */
export function ScrapeLog({ productId, refreshKey }: { productId: number; refreshKey: number }) {
  const [rows, setRows] = useState<LogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.log(productId, PAGE, page * PAGE);
      setRows(r.items);
      setTotal(r.total);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [productId, page]);

  useEffect(() => void load(), [load, refreshKey]);
  useInterval(() => void load(), rows.some((r) => r.outcome === 'running') ? 4000 : 30000);

  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <section className="card">
      <div className="card-head">
        <h2>Scrape log</h2>
        <span className="muted">{total} attempt{total === 1 ? '' : 's'} recorded</span>
      </div>
      {error ? <ErrorNote message={error} onRetry={() => void load()} /> : null}
      {rows.length === 0 && !error ? (
        <p className="muted">No scrape attempts yet.</p>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Attempt</th>
                <th>Outcome</th>
                <th>Took</th>
                <th>Reading</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="nowrap">{dateTime(r.startedAt)}</td>
                  <td className="nowrap">
                    {r.attempt}/{r.maxAttempts} <span className="muted small">· {r.trigger}</span>
                  </td>
                  <td>
                    <OutcomeBadge outcome={r.outcome} />
                  </td>
                  <td className="nowrap">{r.durationMs === null ? '…' : `${(r.durationMs / 1000).toFixed(1)}s`}</td>
                  <td className="nowrap">{r.outcome === 'success' ? `${inr(r.price)} · ${r.stock} in stock` : '—'}</td>
                  <td className="detail">
                    {r.errorCode ? <code>{r.errorCode}</code> : null} {r.message ?? ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 ? (
        <div className="pager">
          <button className="btn btn-small" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            Newer
          </button>
          <span className="muted">
            Page {page + 1} of {pages}
          </span>
          <button className="btn btn-small" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>
            Older
          </button>
        </div>
      ) : null}
    </section>
  );
}
