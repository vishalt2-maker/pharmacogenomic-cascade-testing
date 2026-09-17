/**
 * Migration runner. Applies db/migrations in filename order, once each,
 * recording what was applied and the hash of what was applied.
 *
 * 001_local_auth_shim.sql is skipped when PCT_TARGET=supabase, because
 * Supabase already provides the auth schema it reproduces.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { asService, PROJECT_ROOT } from './client.ts';

const MIGRATIONS_DIR = path.join(PROJECT_ROOT, 'db', 'migrations');

export interface MigrationOutcome {
  name: string;
  status: 'applied' | 'skipped-already' | 'skipped-target';
  hash: string;
}

export async function migrate(
  opts: { log?: (s: string) => void } = {},
): Promise<MigrationOutcome[]> {
  const log = opts.log ?? (() => {});
  const target = process.env.PCT_TARGET ?? 'local';
  const files = (await fs.readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  return asService(async (db) => {
    await db.exec(`
      create table if not exists public.schema_migrations (
        name        text primary key,
        content_hash text not null,
        applied_at  timestamptz not null default now()
      );`);

    const applied = new Map<string, string>(
      (await db.query<{ name: string; content_hash: string }>(
        'select name, content_hash from public.schema_migrations')).rows
        .map((r) => [r.name, r.content_hash]),
    );

    const out: MigrationOutcome[] = [];
    for (const name of files) {
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, name), 'utf8');
      const hash = crypto.createHash('sha256').update(sql).digest('hex');

      if (name.includes('local_auth_shim') && target === 'supabase') {
        out.push({ name, status: 'skipped-target', hash });
        log(`  skip   ${name}  (target=supabase provides auth schema)`);
        continue;
      }
      if (applied.has(name)) {
        if (applied.get(name) !== hash) {
          throw new Error(
            `MIGRATION_DRIFT: ${name} has changed since it was applied. ` +
            `Applied migrations are immutable; add a new file instead.`);
        }
        out.push({ name, status: 'skipped-already', hash });
        continue;
      }
      await db.exec(sql);
      await db.query(
        'insert into public.schema_migrations (name, content_hash) values ($1, $2)',
        [name, hash]);
      out.push({ name, status: 'applied', hash });
      log(`  apply  ${name}`);
    }
    return out;
  });
}
