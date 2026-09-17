/**
 * Test database setup.
 *
 * Every DB test file gets its OWN in-memory PostgreSQL instance, migrated
 * and seeded from the real migration files. Nothing here reimplements the
 * schema: if 003_clinical.sql or 005_rls.sql is wrong, these tests fail,
 * which is the entire point of testing against real Postgres rather than a
 * mock.
 */
process.env.PCT_DATA_DIR = ':memory:';

import { migrate } from '../src/db/migrate.ts';
import { loadRulePack } from '../db/seed/load.ts';
import { RULE_PACK } from '../db/seed/rule-pack-2026.03.1.ts';
import { seedDemoOrganizations, ORG_A, ORG_B, USERS } from '../db/seed/demo-org.ts';
import type { Ctx } from '../src/db/repo.ts';

export { ORG_A, ORG_B, USERS };

export const ctxPhysicianA: Ctx = { userId: USERS.physicianA, orgId: ORG_A };
export const ctxPharmacistA: Ctx = { userId: USERS.pharmacistA, orgId: ORG_A };
export const ctxCounsellorA: Ctx = { userId: USERS.counsellorA, orgId: ORG_A };
export const ctxCoordinatorA: Ctx = { userId: USERS.coordinatorA, orgId: ORG_A };
export const ctxUnregisteredA: Ctx = { userId: USERS.unregisteredA, orgId: ORG_A };
export const ctxPhysicianB: Ctx = { userId: USERS.physicianB, orgId: ORG_B };

let ready: Promise<void> | null = null;

export function setupDb(): Promise<void> {
  ready ??= (async () => {
    await migrate();
    await loadRulePack(RULE_PACK, { activate: true });
    await seedDemoOrganizations();
  })();
  return ready;
}

/** A complete, evaluable case at org A. Each test then breaks one thing. */
export async function makeReadyCase(opts: {
  diplotype?: string; causality?: string; consents?: string[]; verify?: boolean;
} = {}) {
  const repo = await import('../src/db/repo.ts');
  const kase = await repo.createIndexCase(ctxCoordinatorA, {
    mrn: `MRN-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
    yearOfBirth: 1988, sex: 'F', state: 'Maharashtra', preferredLanguage: 'en',
  });
  for (const purpose of opts.consents ?? ['genotyping', 'advisory_issue', 'counselling', 'registry_deidentified']) {
    await repo.recordConsent(ctxCoordinatorA, {
      indexCaseId: kase.id, purpose, granted: true, language: 'en',
      documentRef: 'FORM-DEMO-1',
    });
  }
  const adr = await repo.createAdrEvent(ctxCoordinatorA, {
    indexCaseId: kase.id, suspectDrug: 'carbamazepine', reactionType: 'SJS',
    onsetDate: '2026-08-15', latencyDays: 21,
    causalityWhoUmc: (opts.causality ?? 'probable') as never,
    vigiflowRef: 'IN-DEMO-0001',
  });
  const order = await repo.orderGenotype(ctxPhysicianA, {
    indexCaseId: kase.id, adrEventId: adr.id, geneSymbol: 'HLA-B',
    labName: 'Demo Genomics Laboratory', labAccreditation: 'NABL',
  });
  const result = await repo.enterGenotypeResult(ctxPharmacistA, {
    orderId: order.id, indexCaseId: kase.id, geneSymbol: 'HLA-B',
    diplotype: opts.diplotype ?? '*15:02/*40:06', method: 'PCR-SSP',
    labName: 'Demo Genomics Laboratory', labAccreditation: 'NABL',
    reportRef: 'LAB-DEMO-77421', resultedAt: new Date(Date.now() - 86400000).toISOString(),
  });
  if (opts.verify !== false) {
    await repo.verifyGenotypeResult(ctxPhysicianA, result.id);
  }
  return { kase, adr, order, result };
}
