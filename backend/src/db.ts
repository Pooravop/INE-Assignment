import pg from 'pg';
import type { PGlite as PGliteType } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { log } from './log.js';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = any>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface Db extends Queryable {
  /** Run several statements atomically. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  /** Run a multi-statement script (used for migrations). */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

// numeric and int8 come back from Postgres as strings; the app wants numbers.
const NUMERIC_OID = 1700;
const INT8_OID = 20;

function createPgDb(connectionString: string): Db {
  pg.types.setTypeParser(NUMERIC_OID, (v) => parseFloat(v));
  pg.types.setTypeParser(INT8_OID, (v) => Number(v));
  const local = /@(localhost|127\.0\.0\.1)/.test(connectionString);
  const pool = new pg.Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    ssl: local ? undefined : { rejectUnauthorized: false }, // Supabase requires TLS
  });
  pool.on('error', (err) => log.error('pg pool error', { message: err.message }));

  const wrap = (c: pg.Pool | pg.PoolClient): Queryable => ({
    async query(text, params) {
      const r = await c.query(text, params as any[]);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
  });

  return {
    ...wrap(pool),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(wrap(client));
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
    async exec(sql) {
      await pool.query(sql);
    },
    close: () => pool.end(),
  };
}

async function createPgliteDb(): Promise<Db> {
  // Dev/test only (devDependency): an embedded Postgres so no server is needed.
  const { PGlite } = await import('@electric-sql/pglite');
  const dataDir = process.env.PGLITE_DIR; // undefined => in-memory
  const lite = new PGlite(dataDir);
  await lite.waitReady;
  // PGlite takes type parsers per query (not per instance), unlike node-postgres.
  const parsers = { [NUMERIC_OID]: (v: string) => parseFloat(v), [INT8_OID]: (v: string) => Number(v) };

  const wrap = (c: { query: PGliteType['query'] }): Queryable => ({
    async query(text, params) {
      const r = await c.query(text, params as any[], { parsers });
      return { rows: r.rows as any[], rowCount: r.affectedRows ?? r.rows.length };
    },
  });

  return {
    ...wrap(lite),
    tx: (fn) => lite.transaction((t) => fn(wrap(t as any))),
    async exec(sql) {
      await lite.exec(sql);
    },
    close: () => lite.close(),
  };
}

let instance: Db | undefined;

export async function getDb(): Promise<Db> {
  if (instance) return instance;
  if (config.usePglite) {
    instance = await createPgliteDb();
    log.info('database: embedded PGlite (dev/test)');
  } else if (config.databaseUrl) {
    instance = createPgDb(config.databaseUrl);
    log.info('database: PostgreSQL (Supabase)');
  } else {
    throw new Error('No database configured: set DATABASE_URL (Supabase) or USE_PGLITE=1 for local dev.');
  }
  return instance;
}

/** For tests: install an already-created Db. */
export function setDb(db: Db | undefined) {
  instance = db;
}

export async function createTestDb(): Promise<Db> {
  const db = await createPgliteDb();
  await migrate(db);
  return db;
}

export async function migrate(db: Db): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/ (tsx) and dist/ (tsc) are both one level below backend/, next to sql/.
  const file = path.resolve(here, '..', 'sql', 'schema.sql');
  await db.exec(fs.readFileSync(file, 'utf8'));
}
