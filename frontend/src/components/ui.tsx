import { useEffect, useRef, type ReactNode } from 'react';
import type { Outcome } from '../types';

export function useInterval(fn: () => void, ms: number | null) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    if (ms === null) return;
    const id = setInterval(() => saved.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}

const OUTCOME_LABEL: Record<Outcome, string> = {
  success: 'Success',
  retried: 'Retried',
  failed: 'Failed',
  running: 'Running',
};

export function OutcomeBadge({ outcome }: { outcome: Outcome | null }) {
  if (!outcome) return <span className="badge badge-muted">No runs yet</span>;
  return <span className={`badge badge-${outcome}`}>{OUTCOME_LABEL[outcome]}</span>;
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint ? <div className="stat-hint">{hint}</div> : null}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="spinner-row" role="status">
      <span className="spinner" aria-hidden />
      {label ? <span>{label}</span> : null}
    </div>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="note note-error" role="alert">
      <span>{message}</span>
      {onRetry ? (
        <button className="btn btn-small" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}
