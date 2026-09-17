/**
 * THE DEMONSTRATION SCRIPT.
 *
 * Deliberately ordered so that the system is seen REFUSING before it is
 * seen succeeding. Every other product demo shows the thing doing
 * something. In a safety product, restraint is what a clinical audience
 * remembers, and gate 5 is the gate worth remembering.
 */
import { migrate } from '../db/migrate.ts';
import { loadRulePack } from '../../db/seed/load.ts';
import { RULE_PACK } from '../../db/seed/rule-pack-2026.03.1.ts';
import { seedDemoOrganizations, ORG_A, ORG_B, USERS } from '../../db/seed/demo-org.ts';
import { closeDb, asUser } from '../db/client.ts';
import * as repo from '../db/repo.ts';
import { reason } from '../engine/reason-codes.ts';
import { exportToRegistry, publishAggregate, pilotEndpoints } from '../registry/export.ts';
import { advisoryPdf, pdfIsPossible } from '../render/document-to-pdf.ts';
import { toPlainText } from '../render/advisory.ts';
import fs from 'node:fs/promises';
import path from 'node:path';

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
};

let step = 0;
function scene(title: string) {
  step += 1;
  console.log(`\n${C.bold(`${String(step).padStart(2, '0')}  ${title}`)}`);
  console.log(C.dim('    ' + '─'.repeat(Math.min(72, title.length + 8))));
}
function say(s: string) { console.log(`    ${s}`); }
function note(s: string) { console.log(C.dim(`    ${s}`)); }

function showDecision(result: { decision: string; reasonCodes: string[]; warnings: string[] }) {
  const colour = result.decision === 'BLOCK' ? C.red
    : result.decision === 'ADVISORY_DRAFT' ? C.green
    : C.yellow;
  say(`${colour(C.bold(result.decision))}`);
  for (const code of result.reasonCodes) {
    const r = reason(code);
    say(`  ${C.bold(code)}  ${r.message}`);
    if (r.remedy) note(`    ${r.remedy}`);
  }
  for (const code of result.warnings) {
    note(`  warning: ${code} — ${reason(code).message}`);
  }
}

const POLICY = { allowDemonstrationPack: true };

/** Re-running the demo must not collide with the previous run's records. */
const RUN = Date.now().toString(36).slice(-6).toUpperCase();

const coordinator = { userId: USERS.coordinatorA, orgId: ORG_A };
const physician = { userId: USERS.physicianA, orgId: ORG_A };
const pharmacist = { userId: USERS.pharmacistA, orgId: ORG_A };
const counsellor = { userId: USERS.counsellorA, orgId: ORG_A };
const otherHospital = { userId: USERS.physicianB, orgId: ORG_B };

async function main() {
  console.log(C.bold('\n  PHARMACOGENOMIC CASCADE TESTING — demonstration'));
  console.log(C.dim('  Concept build. Nothing here is deployed, validated, or approved by any regulator.'));

  await migrate();
  await loadRulePack(RULE_PACK, { activate: true });
  await seedDemoOrganizations();

  // =================================================================
  scene('A severe cutaneous reaction is logged at the AMC');
  const kase = await repo.createIndexCase(coordinator, {
    mrn: `MRN-DEMO-${RUN}-INDEX`,
    yearOfBirth: 1991, sex: 'F', state: 'Maharashtra', preferredLanguage: 'en',
  });
  say(`Index case created. Record number stored as a keyed digest, never in plain text.`);
  note(`Family link token issued to the PATIENT: ${kase.family_link_token}`);

  await repo.createAdrEvent(coordinator, {
    indexCaseId: kase.id, suspectDrug: 'carbamazepine', reactionType: 'SJS',
    onsetDate: '2026-08-15', latencyDays: 21, vigiflowRef: 'IN-DEMO-0001',
    causalityWhoUmc: 'not_assessed',
  });
  say('Carbamazepine, Stevens-Johnson Syndrome, onset at 21 days. Causality not yet assessed.');

  // =================================================================
  scene('First refusal: causality has not been assessed');
  let ev = await repo.runEvaluation(physician, { indexCaseId: kase.id, policy: POLICY });
  showDecision(ev.result);
  note('Cascade testing starts from a CONFIRMED index case. An unassessed report is not one.');

  // =================================================================
  scene('Causality assessed as probable. Next refusal: no consent');
  const adrRow = await asUser(physician, async (q) =>
    (await q.query<{ id: string }>(
      `select id from clinical.adr_events where index_case_id = $1`, [kase.id])).rows[0]);
  await repo.assessCausality(physician, adrRow.id, 'probable');
  ev = await repo.runEvaluation(physician, { indexCaseId: kase.id, policy: POLICY });
  showDecision(ev.result);
  note('Consent is recorded separately for each purpose. Never a single blanket flag.');

  // =================================================================
  scene('Consent recorded. THE GATE: no confirmed genotype, no cascade');
  for (const purpose of ['genotyping', 'advisory_issue', 'counselling', 'registry_deidentified']) {
    await repo.recordConsent(coordinator, {
      indexCaseId: kase.id, purpose, granted: true, language: 'en', documentRef: 'FORM-DEMO-1',
    });
  }
  ev = await repo.runEvaluation(physician, { indexCaseId: kase.id, policy: POLICY });
  showDecision(ev.result);
  say(C.bold('This is the differentiator. Every gate before it passed.'));
  note('Universal screening needs hundreds of tests per case prevented, and does not work at');
  note('India’s allele frequency. Cascade testing starts from a confirmed carrier instead —');
  note('so without that confirmation there is nothing to cascade from, and nothing is produced.');

  // =================================================================
  scene('A result arrives, but only one person has seen it');
  const order = await repo.orderGenotype(physician, {
    indexCaseId: kase.id, adrEventId: adrRow.id, geneSymbol: 'HLA-B',
    labName: 'Demo Genomics Laboratory', labAccreditation: 'NABL',
  });
  const result = await repo.enterGenotypeResult(pharmacist, {
    orderId: order.id, indexCaseId: kase.id, geneSymbol: 'HLA-B',
    diplotype: '*15:02/*40:06', method: 'PCR-SSP',
    labName: 'Demo Genomics Laboratory', labAccreditation: 'NABL',
    reportRef: 'LAB-DEMO-77421', resultedAt: new Date(Date.now() - 86_400_000).toISOString(),
  });
  ev = await repo.runEvaluation(physician, { indexCaseId: kase.id, policy: POLICY });
  showDecision(ev.result);

  try {
    await repo.verifyGenotypeResult(pharmacist, result.id);
  } catch (err) {
    say(C.red('Self-verification refused: ') + (err as Error).message.split(':')[0]);
    note('A transcription error in a genotype can route a carrier back onto the drug that');
    note('nearly killed them. Entry and verification are two different people, enforced by');
    note('a database constraint rather than by convention.');
  }

  // =================================================================
  scene('An unrecognised diplotype is never read as absence of risk');
  const scratch = await repo.createIndexCase(coordinator, { mrn: `MRN-DEMO-${RUN}-UNREC` });
  for (const purpose of ['genotyping', 'advisory_issue']) {
    await repo.recordConsent(coordinator, {
      indexCaseId: scratch.id, purpose, granted: true, language: 'en' });
  }
  await repo.createAdrEvent(coordinator, {
    indexCaseId: scratch.id, suspectDrug: 'phenytoin', reactionType: 'TEN',
    causalityWhoUmc: 'certain',
  });
  const o2 = await repo.orderGenotype(physician, { indexCaseId: scratch.id, geneSymbol: 'HLA-B' });
  const r2 = await repo.enterGenotypeResult(pharmacist, {
    orderId: o2.id, indexCaseId: scratch.id, geneSymbol: 'HLA-B',
    diplotype: '*15:11/*40:06', method: 'PCR-SSP', labName: 'Demo Genomics Laboratory',
    labAccreditation: 'NABL', reportRef: 'LAB-DEMO-99999',
    resultedAt: new Date(Date.now() - 86_400_000).toISOString(),
  });
  await repo.verifyGenotypeResult(physician, r2.id);
  const unrec = await repo.runEvaluation(physician, { indexCaseId: scratch.id, policy: POLICY });
  showDecision(unrec.result);
  note('*15:11 is a real allele and not the risk allele. The engine does not assume either way.');

  // =================================================================
  scene('A negative index result produces no document at all');
  const negCase = await repo.createIndexCase(coordinator, { mrn: `MRN-DEMO-${RUN}-NEG` });
  for (const purpose of ['genotyping', 'advisory_issue', 'registry_deidentified']) {
    await repo.recordConsent(coordinator, {
      indexCaseId: negCase.id, purpose, granted: true, language: 'en' });
  }
  await repo.createAdrEvent(coordinator, {
    indexCaseId: negCase.id, suspectDrug: 'carbamazepine', reactionType: 'SJS',
    causalityWhoUmc: 'probable',
  });
  const o3 = await repo.orderGenotype(physician, { indexCaseId: negCase.id, geneSymbol: 'HLA-B' });
  const r3 = await repo.enterGenotypeResult(pharmacist, {
    orderId: o3.id, indexCaseId: negCase.id, geneSymbol: 'HLA-B',
    diplotype: '*40:06/*44:03', method: 'PCR-SSP', labName: 'Demo Genomics Laboratory',
    labAccreditation: 'NABL', reportRef: 'LAB-DEMO-55555',
    resultedAt: new Date(Date.now() - 86_400_000).toISOString(),
  });
  await repo.verifyGenotypeResult(physician, r3.id);
  const neg = await repo.runEvaluation(physician, { indexCaseId: negCase.id, policy: POLICY });
  showDecision(neg.result);
  note('A negative result does not establish absence of risk, so no reassuring document is');
  note('created. Issuing one would invent a false-reassurance harm pathway that did not exist.');

  // =================================================================
  scene('Now the pathway completes: verified by a second clinician');
  await repo.verifyGenotypeResult(physician, result.id);
  ev = await repo.runEvaluation(physician, { indexCaseId: kase.id, policy: POLICY });
  showDecision(ev.result);
  const f = ev.result.finding!;
  say(`Finding: ${f.phenotype.term}, ${f.pair.geneSymbol} and ${f.pair.drugName}.`);
  say(`Actionability ${f.pair.cpicActionability} · recommendation ${f.recommendation.recommendationStrength} · India Evidence Tier ${f.indiaEvidenceTier}`);
  note(`${f.indiaEvidenceTier}: ${f.indiaTierDefinition}`);
  note('The best output the engine can ever produce is a DRAFT. Gate 8 is outside the engine.');

  // =================================================================
  scene('A draft exists. Nothing prints until a named clinician signs');
  const draft = await repo.createAdvisoryDraft(physician, {
    indexCaseId: kase.id, evaluationId: ev.evaluationId, result: ev.result,
    recipientSummary: [
      { relationshipType: 'sibling', count: 2 },
      { relationshipType: 'parent', count: 1 },
    ],
  });
  say('Draft created. Relatives recorded as "two siblings, one parent" — a type and a count.');
  note('There is no relatives table in this schema. That is not an omission; it is the design.');

  try {
    await repo.issueAdvisory(physician, draft.advisoryId);
  } catch (err) {
    say(C.red('Issue refused: ') + (err as Error).message);
    note('Enforced by a database trigger on both INSERT and UPDATE, not by application code.');
  }

  try {
    await repo.signAdvisory(counsellor, draft.advisoryId);
  } catch (err) {
    say(C.red('Sign-off by a counsellor refused: ') + (err as Error).message.split(':')[0]);
  }

  // =================================================================
  scene('Signed, and issued to the index patient');
  const signed = await repo.signAdvisory(physician, draft.advisoryId);
  say(`Signed by Dr A. Narayanan, NMC-DEMO-10001.`);
  note(`Content hash ${signed.contentHash.slice(0, 32)}… — an immutable snapshot, reproducible forever.`);
  await repo.issueAdvisory(physician, draft.advisoryId);
  await repo.recordCounselling(physician, {
    indexCaseId: kase.id, advisoryId: draft.advisoryId, language: 'en',
    topicsCovered: ['variant_meaning', 'familial_probability', 'right_not_to_know', 'alternatives'],
    durationMin: 25,
  });
  say('Counselling recorded, including that the right not to know was covered.');

  const outDir = path.join(process.cwd(), 'demo-output');
  await fs.mkdir(outDir, { recursive: true });
  for (const [which, doc] of [['clinical', signed.rendered.clinical],
                              ['patient', signed.rendered.patient]] as const) {
    await fs.writeFile(path.join(outDir, `${which}-advisory.txt`), toPlainText(doc));
    if (pdfIsPossible(doc)) {
      await fs.writeFile(path.join(outDir, `${which}-advisory.pdf`),
        advisoryPdf(doc, `Rule pack ${RULE_PACK.version}`));
    }
  }
  say(`Documents written to ${C.blue('demo-output/')}`);

  // =================================================================
  scene('Another hospital tries to read this case');
  const seen = await asUser(otherHospital, async (q) =>
    (await q.query(`select id from clinical.index_cases where id = $1`, [kase.id])).rows);
  say(`Rows visible to the second hospital: ${C.bold(String(seen.length))}`);
  note('Row-level security, enforced in PostgreSQL. The query runs; it simply returns nothing.');

  // =================================================================
  scene('A relative decides, on their own, to be tested');
  const relative = await repo.createIndexCase(coordinator, {
    mrn: `MRN-DEMO-${RUN}-RELATIVE`, yearOfBirth: 1994, state: 'Maharashtra' });
  await repo.registerSelfReferral(coordinator, {
    ownIndexCaseId: relative.id,
    presentedToken: kase.family_link_token,
  });
  say('They walked in holding the token the index patient chose to give them.');
  note('They are now their own index case, with their own consent. The system never held the');
  note('link between them; the family did, and used it or did not.');

  // =================================================================
  scene('The registry: de-identified, consented, suppressed');
  const exported = await exportToRegistry({ runBy: 'demo' });
  say(`${exported.rowsExported} of ${exported.rowsConsidered} rows exported. ` +
      `${exported.rowsWithheldNoConsent} withheld for want of consent.`);
  const agg = await publishAggregate(['state', 'suspect_drug', 'phenotype']);
  say(`Aggregate: ${agg.cells.length} cells, ${agg.cellsSuppressed} withheld at a threshold of ${agg.threshold}.`);
  note('In a population with an allele frequency of a couple of per cent, a count of one in a');
  note('named state and month is a person.');

  const endpoints = await pilotEndpoints({ threshold: 1 });
  say('');
  say(C.bold('Blocks by reason — the most valuable operational data this system produces:'));
  for (const b of endpoints.blocksByReason) {
    say(`  ${String(b.n).padStart(3)}  ${b.reason}`);
  }
  say('');
  say(`Predicted carrier yield in tested relatives: ${C.bold('50%')}. Stated in advance, so it can be wrong.`);
  note('If the pilot returns population baseline instead, the thesis is wrong, and the point of');
  note('measuring is to find that out early and cheaply.');

  console.log(`\n${C.dim('  End of demonstration. Run `npm run serve` for the interactive module.')}\n`);
}

try {
  await main();
} catch (err) {
  console.error(C.red(`\nDEMO FAILED: ${err instanceof Error ? err.stack : err}\n`));
  process.exitCode = 1;
} finally {
  await closeDb();
}
