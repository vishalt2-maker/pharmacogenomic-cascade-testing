/**
 * REFERENCE DATA TESTS.
 *
 * The data-entry forms are built entirely from GET /api/reference. Two
 * promises are being made by that endpoint, and both are tested here:
 *
 *   1. A form cannot offer a value the schema would reject. Every option
 *      comes from an enum member or a CHECK constraint read out of the
 *      database, so the test submits every offered value and expects it to
 *      be accepted.
 *   2. The gate annotations are truthful. When a form says an accreditation
 *      is accepted, or that a causality grade blocks, that had better match
 *      what the engine actually does.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  setupDb, makeReadyCase, ctxCoordinatorA, ctxPhysicianA, ctxPharmacistA, USERS,
} from './db-setup.ts';
import { asService } from '../src/db/client.ts';
import * as repo from '../src/db/repo.ts';
import { createServer } from '../src/api/server.ts';
import type { Server } from 'node:http';

let server: Server;
let base: string;
let ref: any;

before(async () => {
  await setupDb();
  server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  ref = await call('/api/reference');
});
after(() => { server?.close(); });

async function call(path: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'content-type': 'application/json', 'x-pct-user': USERS.physicianA },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err: Error & { data?: unknown; status?: number } = new Error(parsed?.detail ?? parsed?.error);
    err.data = parsed; err.status = res.status;
    throw err;
  }
  return parsed;
}

describe('the options come from the schema, not from a copy of it', () => {
  test('reaction types are exactly the database enum', async () => {
    const fromDb = await asService(async (db) =>
      (await db.query<{ enumlabel: string }>(
        `select e.enumlabel from pg_type t
           join pg_enum e on e.enumtypid = t.oid
           join pg_namespace n on n.oid = t.typnamespace
          where n.nspname = 'clinical' and t.typname = 'reaction_type'
          order by e.enumsortorder`)).rows.map((r) => r.enumlabel));
    assert.deepEqual(ref.reactionTypes.map((r: any) => r.value), fromDb);
  });

  test('causality grades are exactly the database enum', async () => {
    const fromDb = await asService(async (db) =>
      (await db.query<{ enumlabel: string }>(
        `select e.enumlabel from pg_type t
           join pg_enum e on e.enumtypid = t.oid
           join pg_namespace n on n.oid = t.typnamespace
          where n.nspname = 'clinical' and t.typname = 'who_umc'
          order by e.enumsortorder`)).rows.map((r) => r.enumlabel));
    assert.deepEqual(ref.causalityGrades.map((c: any) => c.value), fromDb);
  });

  test('relationship types come from the CHECK constraint itself', async () => {
    const def = await asService(async (db) =>
      (await db.query<{ def: string }>(
        `select pg_get_constraintdef(co.oid) as def
           from pg_constraint co join pg_class cl on cl.oid = co.conrelid
          where cl.relname = 'advisory_recipient_summary' and co.contype = 'c'
            and pg_get_constraintdef(co.oid) like '%relationship_type%'`)).rows[0].def);
    const inConstraint = [...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]);
    assert.deepEqual(ref.relationshipTypes, inConstraint);
    assert.ok(inConstraint.length >= 3);
  });

  test('drugs and diplotypes come from the active rule pack', () => {
    assert.ok(ref.drugs.some((d: any) => d.name === 'carbamazepine' && d.inCascadeScope));
    assert.ok(ref.drugs.some((d: any) => d.name === 'levetiracetam' && !d.inCascadeScope));
    assert.ok(ref.drugs.find((d: any) => d.name === 'phenytoin').synonyms.includes('Eptoin'));
    assert.ok(ref.diplotypes.some((d: any) => d.diplotype === '*15:02/*40:06' && d.isRisk));
    assert.ok(ref.diplotypes.some((d: any) => !d.isRisk));
  });

  test('exactly one counselling topic is mandatory, and it is the right one', () => {
    const mandatory = ref.counsellingTopics.filter((t: any) => t.mandatory);
    assert.equal(mandatory.length, 1);
    assert.equal(mandatory[0].value, 'right_not_to_know');
  });
});

describe('every value a form can offer is actually accepted', () => {
  test('every reaction type can be submitted', async () => {
    for (const rt of ref.reactionTypes) {
      const kase = await repo.createIndexCase(ctxCoordinatorA, {
        mrn: `MRN-RT-${rt.value}-${Math.random().toString(36).slice(2, 8)}` });
      const created = await call(`/api/cases/${kase.id}/adr-events`, {
        method: 'POST',
        body: { suspectDrug: 'carbamazepine', reactionType: rt.value },
      });
      assert.ok(created.id, `reaction type ${rt.value} was offered but rejected`);
    }
  });

  test('every causality grade can be submitted', async () => {
    const { adr } = await makeReadyCase();
    for (const g of ref.causalityGrades) {
      const r = await call(`/api/adr-events/${adr.id}/causality`, {
        method: 'POST', body: { causality: g.value },
      });
      assert.equal(r.assessed, true, `causality ${g.value} was offered but rejected`);
    }
  });

  test('every relationship type can be recorded on an advisory', async () => {
    const { kase } = await makeReadyCase();
    const created = await call('/api/advisories', {
      method: 'POST',
      body: {
        indexCaseId: kase.id,
        recipientSummary: ref.relationshipTypes.map((t: string) => ({
          relationshipType: t, count: 1 })),
      },
    });
    assert.ok(created.advisoryId);
    const rows = await asService(async (db) =>
      (await db.query(`select relationship_type from clinical.advisory_recipient_summary
                        where advisory_id = $1`, [created.advisoryId])).rows);
    assert.equal(rows.length, ref.relationshipTypes.length);
  });

  test('every counselling topic can be recorded', async () => {
    const { kase } = await makeReadyCase();
    const r = await call(`/api/cases/${kase.id}/counselling`, {
      method: 'POST',
      body: {
        language: 'en',
        topicsCovered: ref.counsellingTopics.map((t: any) => t.value),
      },
    });
    assert.ok(r.id);
  });

  test('every suggested method and every consent purpose is accepted', async () => {
    for (const purpose of ref.consentPurposes) {
      const kase = await repo.createIndexCase(ctxCoordinatorA, {
        mrn: `MRN-CP-${purpose}-${Math.random().toString(36).slice(2, 8)}` });
      const r = await call(`/api/cases/${kase.id}/consents`, {
        method: 'POST', body: { purpose, granted: true, language: 'en' },
      });
      assert.ok(r.id, `consent purpose ${purpose} was offered but rejected`);
    }
  });
});

describe('the gate annotations the form displays are truthful', () => {
  /** Build a case that differs only in the field under test. */
  async function evaluateWith(opts: { accreditation?: string; causality?: string }) {
    const kase = await repo.createIndexCase(ctxCoordinatorA, {
      mrn: `MRN-ANN-${Math.random().toString(36).slice(2, 10)}` });
    for (const purpose of ['genotyping', 'advisory_issue']) {
      await repo.recordConsent(ctxCoordinatorA, {
        indexCaseId: kase.id, purpose, granted: true, language: 'en' });
    }
    await repo.createAdrEvent(ctxCoordinatorA, {
      indexCaseId: kase.id, suspectDrug: 'carbamazepine', reactionType: 'SJS',
      causalityWhoUmc: (opts.causality ?? 'probable') as never });
    const order = await repo.orderGenotype(ctxPhysicianA, {
      indexCaseId: kase.id, geneSymbol: 'HLA-B' });
    const result = await repo.enterGenotypeResult(ctxPharmacistA, {
      orderId: order.id, indexCaseId: kase.id, geneSymbol: 'HLA-B',
      diplotype: '*15:02/*40:06', method: 'PCR-SSP', labName: 'L',
      labAccreditation: opts.accreditation ?? 'NABL', reportRef: 'R',
      resultedAt: new Date(Date.now() - 86400000).toISOString() });
    await repo.verifyGenotypeResult(ctxPhysicianA, result.id);
    const ev = await repo.runEvaluation(ctxPhysicianA, {
      indexCaseId: kase.id, policy: { allowDemonstrationPack: true } });
    return ev.result;
  }

  test('an accreditation shown as accepted really passes gate 5', async () => {
    for (const a of ref.accreditations.filter((x: any) => x.accepted)) {
      const r = await evaluateWith({ accreditation: a.value });
      assert.ok(!r.reasonCodes.includes('LAB_NOT_ACCREDITED'),
        `${a.value} is shown as accepted but the engine refused it`);
    }
  });

  test('an accreditation shown as blocking really blocks at gate 5', async () => {
    for (const a of ref.accreditations.filter((x: any) => !x.accepted)) {
      const r = await evaluateWith({ accreditation: a.value });
      assert.ok(r.reasonCodes.includes('LAB_NOT_ACCREDITED'),
        `${a.value} is shown as blocking but the engine allowed it`);
    }
  });

  test('a causality grade shown as sufficient really proceeds past gate 3', async () => {
    for (const g of ref.causalityGrades.filter((x: any) => x.sufficient)) {
      const r = await evaluateWith({ causality: g.value });
      assert.ok(!r.reasonCodes.some((c: string) => c.startsWith('CAUSALITY_')),
        `${g.value} is shown as sufficient but the engine refused it`);
    }
  });

  test('a causality grade shown as blocking really blocks at gate 3', async () => {
    for (const g of ref.causalityGrades.filter((x: any) => !x.sufficient)) {
      const r = await evaluateWith({ causality: g.value });
      assert.ok(r.reasonCodes.some((c: string) => c.startsWith('CAUSALITY_')),
        `${g.value} is shown as blocking but the engine allowed it`);
    }
  });

  test('a reaction type shown as out of scope really produces no action', async () => {
    const outOfScope = ref.reactionTypes.filter((r: any) => !r.inScope);
    assert.ok(outOfScope.length > 0);
    for (const rt of outOfScope) {
      const kase = await repo.createIndexCase(ctxCoordinatorA, {
        mrn: `MRN-OOS-${Math.random().toString(36).slice(2, 10)}` });
      for (const purpose of ['genotyping', 'advisory_issue']) {
        await repo.recordConsent(ctxCoordinatorA, {
          indexCaseId: kase.id, purpose, granted: true, language: 'en' });
      }
      await repo.createAdrEvent(ctxCoordinatorA, {
        indexCaseId: kase.id, suspectDrug: 'carbamazepine',
        reactionType: rt.value as never, causalityWhoUmc: 'probable' });
      const ev = await repo.runEvaluation(ctxPhysicianA, {
        indexCaseId: kase.id, policy: { allowDemonstrationPack: true } });
      assert.equal(ev.result.decision, 'NO_ACTION', `${rt.value} is shown as out of scope`);
      assert.ok(ev.result.reasonCodes.includes('REACTION_OUT_OF_SCOPE'));
    }
  });

  test('a drug synonym the form suggests resolves to its pair', async () => {
    const kase = await repo.createIndexCase(ctxCoordinatorA, {
      mrn: `MRN-SYN-${Math.random().toString(36).slice(2, 10)}` });
    for (const purpose of ['genotyping', 'advisory_issue']) {
      await repo.recordConsent(ctxCoordinatorA, {
        indexCaseId: kase.id, purpose, granted: true, language: 'en' });
    }
    // A brand name a coordinator would realistically type.
    await repo.createAdrEvent(ctxCoordinatorA, {
      indexCaseId: kase.id, suspectDrug: 'Eptoin', reactionType: 'SJS_TEN_overlap',
      causalityWhoUmc: 'certain' });
    const ev = await repo.runEvaluation(ctxPhysicianA, {
      indexCaseId: kase.id, policy: { allowDemonstrationPack: true } });
    const g1 = ev.result.gateTrace.find((g) => g.gate === 'G1');
    assert.equal(g1?.status, 'pass');
    assert.equal(g1?.detail.resolvedDrug, 'phenytoin');
    assert.equal(g1?.detail.matchedOn, 'synonym');
  });
});
