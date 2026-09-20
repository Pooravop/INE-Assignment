const inrFmt = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

export const inr = (n: number | null | undefined) => (n === null || n === undefined ? '—' : inrFmt.format(n));

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function timeUntil(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const s = Math.round((new Date(iso).getTime() - now) / 1000);
  if (s <= 60) return 'due now';
  const totalMin = Math.round(s / 60);
  if (totalMin < 60) return `in ${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 24) return m === 0 ? `in ${h} h` : `in ${h} h ${m} min`;
  return `in ${Math.floor(h / 24)} d`;
}

export function intervalLabel(min: number): string {
  if (min % 1440 === 0) return `${min / 1440} day${min === 1440 ? '' : 's'}`;
  if (min % 60 === 0) return `${min / 60} hour${min === 60 ? '' : 's'}`;
  return `${min} min`;
}

export const INTERVALS = [
  { value: 15, label: '15 minutes' },
  { value: 30, label: '30 minutes' },
  { value: 60, label: '1 hour' },
  { value: 120, label: '2 hours (default)' },
  { value: 360, label: '6 hours' },
  { value: 720, label: '12 hours' },
  { value: 1440, label: '24 hours' },
];
