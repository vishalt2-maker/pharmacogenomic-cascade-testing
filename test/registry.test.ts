/**
 * REGISTRY TESTS.
 *
 * Two properties matter more than the rest: nothing is exported without
 * consent, and nothing small enough to identify a person is published.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  setupDb, makeReadyCase, ctxPhysicianA, ctxCoordinatorA,
} from './db-setup.ts';
import { asUser, asService } from '../src/db/client.ts';
import * as repo from '../src/db/repo.ts';
import {
  exportToRegistry, publishAggregate, pilotEndpoints, DEFAULT_SUPPRESSION_THRESHOLD,
} from '../src/registry/export.ts';

before(async () => { await setupDb(); });
const POLICY = { allowDemonstrationPack: true };

async function evaluatedCase(opts: Parameters<typeof makeReadyCase>[0] = {}) {
  const made = await makeReadyCase(opts);
  const ev = await repo.runEvaluation(ctxPhysicianA, {
    indexCaseId: made.kase.id, policy: POLICY });
  return { ...made, ev };
}

describe('consent governs every export, every time', () => {
  test('a case without registry consent is withheld', async () => {
    await evaluatedCase({ consents: ['genotyping', 'advisory_issue'] });
    const out = await exportToRegistry({ runBy: 'test', dryRun: true });
    assert.ok(out.rowsWithheldNoConsent >= 1,
      'a case with no registry consent must not reach the registry');
  });

  test('a case with registry consent is exported', async () => {
    const before = await exportToRegistry({ runBy: 'test', dryRun: true });
    await evaluatedCase();
    const after = await exportToRegistry({ runBy: 'test', dryRun: true });
    assert.equal(after.rowsExported, before.rowsExported + 1);
  });

  test('WITHDRAWING consent removes the case from subsequent exports', async () => {
    const { kase } = await evaluatedCase();
    const before = await exportToRegistry({ runBy: 'test', dryRun: true });

    await asUser(ctxCoordinatorA, async (q) =>
      q.query(`update clinical.consents set withdrawn_at = now()
                where index_case_id = $1 and purpose = 'registry_deidentified'`, [kase.id]));

    const after = await exportToRegistry({ runBy: 'test', dryRun: true });
    assert.equal(after.rowsExported, before.rowsExported - 1,
      'withdrawal must be honoured at export time, not only at collection time');
  });
});

describe('the exported rows are de-identified', () => {
  test('no identifier survives into the registry table', async () => {
    await evaluatedCase();
    await exportToRegistry({ runBy: 'test' });
    const cols = await asService(async (db) =>
      (await db.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'registry' and table_name = 'cascade_records'`)).rows
        .map((c) => c.column_name));
    for (const forbidden of ['org_id', 'index_case_id', 'case_id', 'mrn', 'mrn_hash',
      'patient', 'name', 'family_link_token', 'report_ref']) {
      assert.ok(!cols.includes(forbidden), `registry must not carry ${forbidden}`);
    }
  });

  test('dates are coarsened to the month', async () => {
    await evaluatedCase();
    await exportToRegistry({ runBy: 'test' });
    const rows = await asService(async (db) =>
      (await db.query<{ year_month: string }>(
        `select year_month from registry.cascade_records`)).rows);
    assert.ok(rows.length > 0);
    for (const r of rows) assert.match(r.year_month, /^\d{4}-\d{2}$/);
  });

  test('an export run is itself recorded', async () => {
    const out = await exportToRegistry({ runBy: 'test-runner' });
    const run = await asService(async (db) =>
      (await db.query<Record<string, unknown>>(
        `select * from registry.export_runs where id = $1`, [out.runId!])).rows[0]);
    assert.equal(run.run_by, 'test-runner');
    assert.equal(Number(run.suppression_threshold), DEFAULT_SUPPRESSION_THRESHOLD);
  });
});

describe('small-cell suppression', () => {
  test('a cell below the threshold is withheld, and reported as withheld', async () => {
    await evaluatedCase();
    await exportToRegistry({ runBy: 'test' });
    const agg = await publishAggregate(['state', 'year_month'], { threshold: 1000 });
    assert.ok(agg.cellsSuppressed > 0);
    assert.ok(agg.cells.every((c) => c.suppressed && c.count === null),
      'a suppressed cell must carry no count at all');
  });

  test('a cell at or above the threshold is published', async () => {
    const agg = await publishAggregate(['gene_symbol'], { threshold: 1 });
    assert.ok(agg.cells.some((c) => !c.suppressed && (c.count ?? 0) >= 1));
  });

  test('suppression cannot be switched off', async () => {
    const agg = await publishAggregate(['state'], { threshold: 0 });
    assert.ok(agg.threshold >= 1, 'a threshold of zero must be clamped, not honoured');
  });

  test('a dimension outside the publishable set is refused', async () => {
    await assert.rejects(publishAggregate(['diplotype_and_state' as never]),
      /REGISTRY_DIMENSION_REFUSED/);
    await assert.rejects(publishAggregate([]), /REGISTRY_DIMENSION_REQUIRED/);
  });

  test('diplotype is not publishable as a grouping dimension', async () => {
    // A rare diplotype plus a state plus a month is a person.
    await assert.rejects(publishAggregate(['diplotype' as never]),
      /REGISTRY_DIMENSION_REFUSED/);
  });
});

describe('pilot endpoints -- the falsifiable prediction', () => {
  test('rates are suppressed while the denominator is small', async () => {
    const e = await pilotEndpoints({ threshold: 1000 });
    assert.equal(e.indexGenotypingRate, null);
    assert.equal(e.carrierYieldInTestedRelatives, null);
    assert.equal(e.predictedCarrierYield, 0.5,
      'the prediction is stated up front so it can be falsified');
  });

  test('blocks are counted by reason: the best pilot metric available', async () => {
    await evaluatedCase({ verify: false });
    const e = await pilotEndpoints({ threshold: 1 });
    const codes = e.blocksByReason.map((b) => b.reason);
    assert.ok(codes.includes('GENOTYPE_UNVERIFIED') || codes.includes('GENOTYPE_REQUIRED'),
      `expected a genotype block, saw ${JSON.stringify(codes)}`);
    assert.ok(e.blocksByReason.every((b) => b.n > 0));
  });

  test('rates compute once the denominator is large enough', async () => {
    const e = await pilotEndpoints({ threshold: 1 });
    assert.ok(e.indexCasesEvaluated > 0);
    assert.ok(e.indexGenotypingRate !== null);
    assert.ok(e.indexGenotypingRate! >= 0 && e.indexGenotypingRate! <= 1);
  });
});

describe('relatives appear only because they chose to present a token', () => {
  test('a self-referred relative becomes their own index case, with their own consent', async () => {
    const { kase } = await evaluatedCase();
    const token = await asUser(ctxCoordinatorA, async (q) =>
      (await q.query<{ family_link_token: string }>(
        `select family_link_token from clinical.index_cases where id = $1`, [kase.id]))
        .rows[0].family_link_token);

    const relativeOwnCase = await repo.createIndexCase(ctxCoordinatorA, {
      mrn: 'MRN-RELATIVE-1', yearOfBirth: 1992, state: 'Maharashtra', preferredLanguage: 'en',
    });
    const sr = await repo.registerSelfReferral(ctxCoordinatorA, {
      ownIndexCaseId: relativeOwnCase.id, presentedToken: token,
    });
    assert.ok(sr.id);

    const row = await asUser(ctxCoordinatorA, async (q) =>
      (await q.query<Record<string, unknown>>(
        `select * from clinical.self_referred_individuals where id = $1`, [sr.id])).rows[0]);
    assert.ok(row.own_consent_at, 'the relative consents in their own right');
    assert.equal(row.own_index_case_id, relativeOwnCase.id);
  });

  test('the right not to know is recordable as an outcome', async () => {
    const own = await repo.createIndexCase(ctxCoordinatorA, { mrn: 'MRN-DECLINED-1' });
    const sr = await repo.registerSelfReferral(ctxCoordinatorA, {
      ownIndexCaseId: own.id, declinedInformation: true,
    });
    const row = await asUser(ctxCoordinatorA, async (q) =>
      (await q.query<{ declined_information: boolean }>(
        `select declined_information from clinical.self_referred_individuals where id = $1`,
        [sr.id])).rows[0]);
    assert.equal(row.declined_information, true);
  });

  test('a relative who presents no token is still their own subject', async () => {
    const own = await repo.createIndexCase(ctxCoordinatorA, { mrn: 'MRN-NOTOKEN-1' });
    const sr = await repo.registerSelfReferral(ctxCoordinatorA, { ownIndexCaseId: own.id });
    assert.ok(sr.id, 'presenting the token is optional; consenting is not');
  });
});
