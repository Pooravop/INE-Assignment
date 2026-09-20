import type { Alert, HistoryPoint, LogRow, Product, SearchHit, Stats, Status } from './types';

const BASE = ((import.meta.env.VITE_API_URL as string | undefined) ?? '').replace(/\/+$/, '');

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. It may be starting up; try again in a moment.');
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string } | null)?.error ?? `Request failed (${res.status})`);
  return body as T;
}

export const api = {
  status: () => request<Status>('/api/status'),
  search: (q: string) => request<{ results: SearchHit[] }>(`/api/catalog/search?q=${encodeURIComponent(q)}&limit=30`),
  products: () => request<Product[]>('/api/products'),
  product: (id: number) => request<{ product: Product; stats: Stats }>(`/api/products/${id}`),
  history: (id: number) => request<HistoryPoint[]>(`/api/products/${id}/history?limit=2000`),
  log: (id: number, limit: number, offset: number) =>
    request<{ total: number; items: LogRow[] }>(`/api/products/${id}/log?limit=${limit}&offset=${offset}`),
  track: (storeProductId: number, intervalMinutes?: number) =>
    request<{ product: Product; created: boolean }>('/api/products', {
      method: 'POST',
      body: JSON.stringify({ storeProductId, intervalMinutes }),
    }),
  update: (id: number, patch: { intervalMinutes?: number; active?: boolean }) =>
    request<Product>(`/api/products/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  remove: (id: number) => request<void>(`/api/products/${id}`, { method: 'DELETE' }),
  scrapeNow: (id: number) => request<{ accepted: boolean; started: boolean; queued: boolean }>(`/api/products/${id}/scrape`, { method: 'POST' }),
  alerts: () => request<Alert[]>('/api/alerts?limit=20'),
};
