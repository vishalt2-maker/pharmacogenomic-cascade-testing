/**
 * ROW-LEVEL SECURITY TESTS.
 *
 * The specification's acceptance criterion: "Verify isolation by trying to
 * read another organisation's data and failing."
 *
 * These run against real PostgreSQL with the real policies from
 * 005_rls.sql. A passing test here means the policy works, not that a mock
 * agreed with itself.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  setupDb, makeReadyCase, ctxPhysicianA, ctxPhysicianB, ctxCoordinatorA, ORG_A, ORG_B,
} from './db-setup.ts';
import { asUser, asService } from '../src/db/client.ts';
import * as repo from '../src/db/repo.ts';

before(async () => { await setupDb(); });

describe('organisation isolation', () => {
  test('a hospital cannot read another hospital’s index cases', async () => {
    const { kase } = await makeReadyCase();

    const own = await asUser(ctxCoordinatorA, async (q) =>
      (await q.query(`select id from clinical.index_cases where id = $1`, [kase.id])).rows);
    assert.equal(own.length, 1, 'the owning organisation must see its own case');

    const other = await asUser(ctxPhysicianB, async (q) =>
      (await q.query(`select id from clinical.index_cases where id = $1`, [kase.id])).rows);
    assert.equal(other.length, 0, 'ANOTHER ORGANISATION MUST SEE NOTHING');
  });

  test('a hospital cannot read another hospital’s ADR events', async () => {
    const { adr } = await makeReadyCase();
    const rows = await asUser(ctxPhysicianB, async (q) =>
      (await q.query(`select id from clinical.adr_events where id = $1`, [adr.id])).rows);
    assert.equal(rows.length, 0);
  });

  test('a hospital cannot read another hospital’s genotype results', async () => {
    const { result } = await makeReadyCase();
    const rows = await asUser(ctxPhysicianB, async (q) =>
      (await q.query(`select id from clinical.genotype_results where id = $1`, [result.id])).rows);
    assert.equal(rows.length, 0, 'a genotype is the most sensitive row in the system');
  });

  test('a hospital cannot read another hospital’s consents', async () => {
    const { kase } = await makeReadyCase();
    const rows = await asUser(ctxPhysicianB, async (q) =>
      (await q.query(`select id from clinical.consents where index_case_id = $1`, [kase.id])).rows);
    assert.equal(rows.length, 0);
  });

  test('an unfiltered SELECT returns only the caller’s own organisation', async () => {
    await makeReadyCase();
    const rows = await asUser(ctxPhysicianB, async (q) =>
      (await q.query<{ org_id: string }>(`select org_id from clinical.index_cases`)).rows);
    assert.ok(rows.every((r) => r.org_id === ORG_B),
      'a policy that leaks on an unfiltered scan is not a policy');
  });

  test('a hospital cannot WRITE a row into another organisation', async () => {
    await assert.rejects(
      asUser(ctxPhysicianB, async (q) =>
        q.query(
          `insert into clinical.index_cases (org_id, mrn_hash) values ($1,$2)`,
          [ORG_A, 'forged-hash'])),
      /row-level security|policy/i);
  });

  test('a hospital cannot move its own case into another organisation', async () => {
    const { kase } = await makeReadyCase();
    await assert.rejects(
      asUser(ctxCoordinatorA, async (q) =>
        q.query(`update clinical.index_cases set org_id = $2 where id = $1`, [kase.id, ORG_B])),
      /row-level security|policy/i);
  });

  test('an unauthenticated session sees nothing at all', async () => {
    await makeReadyCase();
    const rows = await asUser({ userId: '00000000-0000-4000-8000-000000000000', orgId: ORG_A },
      async (q) => (await q.query(`select id from clinical.index_cases`)).rows);
    assert.equal(rows.length, 0,
      'auth.uid() with no matching app_user must resolve to no organisation at all');
  });

  test('evaluations, including blocks, are isolated per organisation', async () => {
    const { kase } = await makeReadyCase();
    await repo.runEvaluation(ctxPhysicianA, { indexCaseId: kase.id, policy: { allowDemonstrationPack: true } });
    const mine = await repo.listEvaluations(ctxPhysicianA, kase.id);
    assert.ok(mine.length >= 1);
    const theirs = await repo.listEvaluations(ctxPhysicianB, kase.id);
    assert.equal(theirs.length, 0);
  });
});

describe('the audit log is append-only, and enforced as such', () => {
  test('a user can write and read their own organisation’s audit entries', async () => {
    const { kase } = await makeReadyCase();
    const rows = await asUser(ctxCoordinatorA, async (q) =>
      (await q.query(`select action from clinical.audit_log where object_id = $1`, [kase.id])).rows);
    assert.ok(rows.length >= 1);
  });

  test('UPDATE on the audit log is refused', async () => {
    await makeReadyCase();
    await assert.rejects(
      asService(async (db) => db.query(`update clinical.audit_log set action = 'tampered'`)),
      /AUDIT_LOG_APPEND_ONLY/);
  });

  test('DELETE on the audit log is refused, even for a privileged caller', async () => {
    await makeReadyCase();
    await assert.rejects(
      asService(async (db) => db.query(`delete from clinical.audit_log`)),
      /AUDIT_LOG_APPEND_ONLY/);
  });

  test('an audit entry cannot be forged against another organisation', async () => {
    await assert.rejects(
      asUser(ctxPhysicianB, async (q) =>
        q.query(
          `insert into clinical.audit_log (actor_id, org_id, action, object_type)
           values ($1,$2,'forged','index_case')`,
          [ctxPhysicianB.userId, ORG_A])),
      /row-level security|policy/i);
  });

  test('the audit log refuses clinical free text in its detail column', async () => {
    const { assertCodesOnly } = await import('../src/db/audit.ts');
    assert.throws(
      () => assertCodesOnly({ note: 'Patient developed a widespread rash on day 21 of therapy.' }),
      /AUDIT_DETAIL_REJECTED/);
    assert.doesNotThrow(() => assertCodesOnly({ decision: 'BLOCK', gate: 'G5', count: 3 }));
  });
});

describe('the knowledge layer is readable by everyone and writable by nobody', () => {
  test('any authenticated user can read the active rule pack', async () => {
    for (const ctx of [ctxPhysicianA, ctxPhysicianB]) {
      const rows = await asUser(ctx, async (q) =>
        (await q.query(`select version from knowledge.rule_packs where is_active`)).rows);
      assert.equal(rows.length, 1);
    }
  });

  test('an application user cannot alter the science', async () => {
    await assert.rejects(
      asUser(ctxPhysicianA, async (q) =>
        q.query(`update knowledge.recommendations set action_code = 'standard_dose'`)),
      /permission denied|row-level security|policy/i);
  });

  test('an application user cannot insert a rule pack', async () => {
    await assert.rejects(
      asUser(ctxPhysicianA, async (q) =>
        q.query(
          `insert into knowledge.rule_packs
             (version, published_at, effective_from, expires_at, content_hash, content_json)
           values ('forged', now(), now(), now() + interval '1 day', 'x', '{}'::jsonb)`)),
      /permission denied|row-level security|policy/i);
  });
});

describe('there is no table to put relatives in', () => {
  test('the schema holds no relatives table, by construction', async () => {
    const rows = await asService(async (db) =>
      (await db.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema = 'clinical'`)).rows);
    const names = rows.map((r) => r.table_name);
    for (const forbidden of ['relatives', 'family_members', 'contacts', 'relative_contacts']) {
      assert.ok(!names.includes(forbidden), `found a ${forbidden} table`);
    }
    assert.ok(names.includes('advisory_recipient_summary'),
      'what exists instead is a relationship type and a count');
  });

  test('the recipient summary holds counts, and has nowhere to put a name', async () => {
    const cols = await asService(async (db) =>
      (await db.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'clinical' and table_name = 'advisory_recipient_summary'`)).rows);
    const names = cols.map((c) => c.column_name);
    assert.deepEqual(new Set(names),
      new Set(['id', 'advisory_id', 'relationship_type', 'count', 'recorded_at']));
    for (const forbidden of ['name', 'phone', 'email', 'contact', 'address', 'mrn']) {
      assert.ok(!names.some((n) => n.includes(forbidden)),
        `advisory_recipient_summary must have no ${forbidden} column`);
    }
  });
});
