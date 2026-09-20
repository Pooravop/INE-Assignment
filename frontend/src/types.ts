export type Outcome = 'running' | 'success' | 'retried' | 'failed';

export interface Product {
  id: number;
  storeProductId: number;
  name: string;
  brand: string;
  category: string;
  sku: string;
  description: string;
  intervalMinutes: number;
  active: boolean;
  createdAt: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  lastPrice: number | null;
  lastStock: number | null;
  lowPrice: number | null;
  highPrice: number | null;
  readings: number;
  lastOutcome: Outcome | null;
  lastError: string | null;
  nextDueAt: string | null;
  mrp: number | null;
  dealPrice: number | null;
  discountPct: number | null;
  rating: number | null;
  ratingCount: number | null;
  seller: string | null;
  prevPrice: number | null;
}

export interface SearchHit {
  id: number;
  name: string;
  brand: string;
  category: string;
  sku: string;
  description: string;
  tracked_id: number | null;
}

export interface HistoryPoint {
  scrapedAt: string;
  price: number;
  stock: number;
  mrp: number | null;
  dealPrice: number | null;
  discountPct: number | null;
  rating: number | null;
}

export interface LogRow {
  id: number;
  runId: string;
  attempt: number;
  maxAttempts: number;
  trigger: string;
  startedAt: string;
  durationMs: number | null;
  outcome: Outcome;
  errorCode: string | null;
  message: string | null;
  price: number | null;
  stock: number | null;
}

export interface Stats {
  attempts: number;
  successes: number;
  retried: number;
  failed: number;
  runSuccessRate: number | null;
}

export interface Alert {
  id: number;
  productId: number | null;
  productName: string | null;
  kind: 'price_drop' | 'back_in_stock' | 'out_of_stock' | 'structure_change';
  message: string;
  createdAt: string;
}

export interface Status {
  scraping: boolean;
  schedule: { defaultIntervalMinutes: number; trigger: string };
  catalog: { items: number; syncedAt: string | null };
}
