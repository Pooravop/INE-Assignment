import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { Dashboard } from './components/Dashboard';
import { ProductPage } from './components/ProductPage';
import { Search } from './components/Search';
import { useInterval } from './components/ui';
import type { Alert, Product, Status } from './types';

type Route = { name: 'home' } | { name: 'product'; id: number };

function parseHash(hash: string): Route {
  const m = hash.match(/^#\/product\/(\d+)/);
  return m ? { name: 'product', id: Number(m[1]) } : { name: 'home' };
}

function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  useEffect(() => {
    const on = () => {
      setRoute(parseHash(location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export default function App() {
  const route = useRoute();
  const [products, setProducts] = useState<Product[] | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [waking, setWaking] = useState(false);

  const load = useCallback(async () => {
    try {
      const [p, a, s] = await Promise.all([api.products(), api.alerts().catch(() => []), api.status().catch(() => null)]);
      setProducts(p);
      setAlerts(a);
      setStatus(s);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
      setWaking(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // Free-tier backends sleep; tell the user why the first load is slow instead of looking broken.
    const t = setTimeout(() => setWaking(true), 3500);
    return () => clearTimeout(t);
  }, [load]);

  useInterval(() => void load(), status?.scraping ? 10000 : 45000);

  return (
    <div className="app">
      <header className="topbar">
        <a href="#/" className="brand">
          <span className="brand-mark" aria-hidden>
            ↗
          </span>
          Price Tracker
        </a>
        <div className="topbar-right">
          {status?.scraping ? (
            <span className="pill pill-live">
              <span className="dot" /> Scraping now
            </span>
          ) : (
            <span className="pill">Scheduled every {status ? status.schedule.defaultIntervalMinutes / 60 : 2} h</span>
          )}
        </div>
      </header>

      <main className="container">
        {waking && loading ? (
          <div className="note" role="status">
            Waking up the server (free-tier hosting sleeps when idle). This can take up to a minute…
          </div>
        ) : null}
        {route.name === 'home' ? (
          <>
            <Search onTracked={() => void load()} />
            <Dashboard products={products} loading={loading} error={error} reload={() => void load()} alerts={alerts} />
          </>
        ) : (
          <ProductPage key={route.id} id={route.id} />
        )}
      </main>

      <footer className="footer muted small">
        Tracks products from the INE mock store only. Prices come from scheduled scrapes, not live queries.
      </footer>
    </div>
  );
}
