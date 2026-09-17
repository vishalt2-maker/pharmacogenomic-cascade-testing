/**
 * PORTABILITY TESTS.
 *
 * These exist because a clean clone is not the same thing as the machine
 * the project was written on. Everything git-ignored is absent, every
 * directory created by hand during development is gone, and every script
 * referenced by package.json had better be a file that exists.
 *
 * The first test here is a regression: the rest of the suite runs against
 * an in-memory database, so it passed happily while a fresh clone could not
 * create a file-backed one at all.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Must be set before anything opens a database. Each test file runs in its
// own process, so this is local to this file.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pct-portability-'));
const NESTED = path.join(TMP_ROOT, 'does', 'not', 'exist', 'yet', 'pgdata');
process.env.PCT_DATA_DIR = NESTED;

const { migrate } = await import('../src/db/migrate.ts');
const { asService, closeDb } = await import('../src/db/client.ts');

after(async () => {
  await closeDb();
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe('a fresh clone can create its database', () => {
  test('the data directory is created even when its parents do not exist', async () => {
    // In a fresh clone `.data/` is absent: it is git-ignored scratch. PGlite
    // creates its own directory but not the parents, so this used to fail
    // with ENOENT on the very first command a new user ran.
    assert.equal(fs.existsSync(NESTED), false, 'precondition: the path must not exist');

    const applied = await migrate();
    assert.ok(applied.length >= 6, 'every migration should have been applied');
    assert.ok(fs.existsSync(NESTED), 'the data directory should now exist');
  });

  test('the migrated database is usable', async () => {
    const rows = await asService(async (db) =>
      (await db.query<{ n: string }>(
        `select count(*)::text as n from information_schema.tables
          where table_schema in ('knowledge','clinical','registry')`)).rows);
    assert.ok(Number(rows[0].n) > 20, `expected the full schema, saw ${rows[0].n} tables`);
  });

  test('migrations are recorded so a second run is a no-op', async () => {
    const second = await migrate();
    assert.ok(second.every((m) => m.status !== 'applied'),
      'a second migrate must not reapply anything');
  });
});

describe('the project is self-sufficient', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  test('every file referenced by a package script exists', () => {
    const missing: string[] = [];
    for (const [name, command] of Object.entries(pkg.scripts as Record<string, string>)) {
      for (const m of command.matchAll(/(?:^|\s)((?:src|scripts|test|db)\/[\w./-]+\.(?:ts|cjs|mjs|js))/g)) {
        const file = path.join(root, m[1]);
        if (!fs.existsSync(file)) missing.push(`${name} -> ${m[1]}`);
      }
    }
    assert.deepEqual(missing, [], 'a script pointing at a missing file breaks on first use');
  });

  test('the Node version floor matches what type stripping actually needs', () => {
    // Node runs the TypeScript directly. That is default behaviour from
    // 22.18 and 23.6; below that it needs a flag or does not exist.
    assert.equal(pkg.engines.node, '>=22.18.0');
    assert.ok(process.version.startsWith('v'));
  });

  test('the preflight script parses as plain CommonJS on any Node', () => {
    const src = fs.readFileSync(path.join(root, 'scripts', 'check-node.cjs'), 'utf8');
    // It has to run on a Node far too old for the project, to explain why.
    for (const modern of [/=>/, /\bconst\b/, /\blet\b/, /\?\./, /\?\?/, /`/]) {
      assert.ok(!modern.test(src),
        `check-node.cjs uses ${modern} — it must parse on very old Node`);
    }
  });

  test('nothing git-ignored is required for a first run', () => {
    const ignored = fs.readFileSync(path.join(root, '.gitignore'), 'utf8')
      .split('\n').map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('*'));
    // Each of these is scratch, rebuilt on demand. If one became load-bearing,
    // a clean clone would break and nothing else in the suite would notice.
    assert.deepEqual(ignored.sort(), ['.DS_Store', '.data/', 'demo-output/', 'node_modules/']);
  });
});
