/**
 * Database client.
 *
 * The demo runs against PGlite: real PostgreSQL compiled to WebAssembly,
 * in-process, no server to install. That matters more than convenience --
 * it means the row-level security policies, the sign-off trigger and the
 * append-only audit log in db/migrations are the ones actually exercised by
 * the tests, not a hand-written imitation of them.
 *
 * The same SQL is intended to run unchanged against Supabase or any
 * PostgreSQL 15+, minus 001_local_auth_shim.sql.
 */
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

export const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export type Row = Record<string, unknown>;

export interface QueryResult<T = Row> {
  rows: T[];
  affectedRows?: number;
}

let instance: PGlite | null = null;
let opening: Promise<PGlite> | null = null;

export function dataDir(): string {
  return process.env.PCT_DATA_DIR ?? path.join(PROJECT_ROOT, '.data', 'pgdata');
}

export async function getDb(): Promise<PGlite> {
  if (instance) return instance;
  if (opening) return opening;
  const dir = dataDir();

  if (dir !== ':memory:') {
    // PGlite creates its own data directory but not the parents. In a fresh
    // clone `.data/` does not exist, because it is scratch and git-ignored,
    // so the first run would fail on a missing parent. Make the whole path.
    fs.mkdirSync(path.dirname(path.resolve(dir)), { recursive: true });
  }

  opening = PGlite.create(
    dir === ':memory:'
      ? { extensions: { pgcrypto } }
      : { dataDir: dir, extensions: { pgcrypto } },
  ).then((db) => { instance = db; return db; });
  return opening;
}

export async function closeDb(): Promise<void> {
  if (instance) { await instance.close(); instance = null; opening = null; }
}

/**
 * PGlite is a single connection. Every caller is serialised through this
 * queue so that a `set local role` belonging to one request can never leak
 * into another. On a pooled server this role is the connection's own.
 */
let tail: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.then(() => undefined, () => undefined);
  return run;
}

/** Service-role access: bypasses RLS. Migrations, seeding, registry export. */
export async function asService<T>(fn: (db: PGlite) => Promise<T>): Promise<T> {
  const db = await getDb();
  return serialize(async () => fn(db));
}

export interface UserContext {
  userId: string;
  orgId?: string;
}

/**
 * Run work as an authenticated application user, inside a transaction, with
 * the RLS context set exactly the way Supabase sets it.
 *
 * `set local` scopes both the role and the JWT subject claim to this
 * transaction, so they are unwound on COMMIT or ROLLBACK whatever happens --
 * including a thrown error. An escaped role is a cross-tenant data leak, so
 * it is not left to a `finally` block to tidy up.
 */
export async function asUser<T>(
  ctx: UserContext,
  fn: (q: Queryer) => Promise<T>,
): Promise<T> {
  const db = await getDb();
  return serialize(async () => {
    await db.exec('begin');
    try {
      await db.query(`select set_config('role', 'authenticated', true)`);
      await db.query(
        `select set_config('request.jwt.claim.sub', $1, true)`, [ctx.userId]);
      const q: Queryer = {
        query: (sql, params) => db.query(sql, params) as any,
        exec: (sql) => db.exec(sql).then(() => undefined),
      };
      const out = await fn(q);
      await db.exec('commit');
      return out;
    } catch (err) {
      try { await db.exec('rollback'); } catch { /* connection already unwound */ }
      throw err;
    }
  });
}

export interface Queryer {
  query<T = Row>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  exec(sql: string): Promise<void>;
}

/** Postgres surfaces our RAISE EXCEPTION messages as `CODE: detail`. */
export function pgErrorCode(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /^([A-Z][A-Z0-9_]{3,}):/.exec(msg.trim());
  return m ? m[1] : null;
}
