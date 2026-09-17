/**
 * SIGN-OFF TESTS.
 *
 * The specification's acceptance criterion: "Prove an advisory cannot reach
 * issued unsigned."
 *
 * Proving it through the application layer is not enough. The trigger is
 * tested directly, by trying to reach the issued state through every path
 * the database offers, including the INSERT path that the blueprint's
 * UPDATE-only trigger would not have caught.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  setupDb, makeReadyCase, ctxPhysicianA, ctxPharmacistA, ctxCounsellorA,
  ctxCoordinatorA, ctxUnregisteredA, ctxPhysicianB, ORG_A,
} from './db-setup.ts';
import { asUser, asService } from '../src/db/client.ts';
import * as repo from '../src/db/repo.ts';

before(async () => { await setupDb(); });

const POLICY = { allowDemonstrationPack: true };

async function draftFor(caseId: string) {
  const ev = await repo.runEvaluation(ctxPhysicianA, { indexCaseId: caseId, policy: POLICY });
  assert.equal(ev.result.decision, 'ADVISORY_DRAFT', ev.result.reasonCodes.join(','));
  return repo.createAdvisoryDraft(ctxPhysicianA, {
    indexCaseId: caseId, evaluationId: ev.evaluationId, result: ev.result,
  });
}

describe('an advisory cannot reach "issued" unsigned', () => {
  test('UPDATE to issued without a sign-off is refused by the trigger', async () => {
    const { kase } = await makeReadyCase();
    const { advisoryId } = await draftFor(kase.id);
    await assert.rejects(
      asUser(ctxPhysicianA, async (q) =>
        q.query(`update clinical.advisories set status = 'issued' where id = $1`, [advisoryId])),
      /ADVISORY_UNSIGNED/);
  });

  test('INSERT directly as issued is refused too -- the hole the blueprint left open', async () => {
    const { kase } = await makeReadyCase();
    const ev = await repo.runEvaluation(ctxPhysicianA, { indexCaseId: kase.id, policy: POLICY });
    await assert.rejects(
      asUser(ctxPhysicianA, async (q) =>
        q.query(
          `insert into clinical.advisories
             (index_case_id, evaluation_id, org_id, status, rule_pack_version,
              guideline_citation, guideline_version, india_evidence_tier,
              content_clinical, content_patient, content_hash)
           values ($1,$2,$3,'issued','2026.03.1','forged','1','IN-2',
                   '{}'::jsonb,'{}'::jsonb,'deadbeef')`,
          [kase.id, ev.evaluationId, ORG_A])),
      /ADVISORY_UNSIGNED/,
      'a BEFORE UPDATE trigger alone would have let this through');
  });

  test('a service-role caller cannot bypass the trigger either', async () => {
    const { kase } = await makeReadyCase();
    const { advisoryId } = await draftFor(kase.id);
    await assert.rejects(
      asService(async (db) =>
        db.query(`update clinical.advisories set status = 'issued' where id = $1`, [advisoryId])),
      /ADVISORY_UNSIGNED/,
      'RLS can be bypassed by the service role; a trigger cannot');
  });

  test('issuing without active advisory consent is refused, even when signed', async () => {
    const { kase } = await makeReadyCase({ consents: ['genotyping', 'advisory_issue'] });
    const { advisoryId } = await draftFor(kase.id);
    await repo.signAdvisory(ctxPhysicianA, advisoryId);

    // Withdraw the advisory consent after signing.
    await asUser(ctxCoordinatorA, async (q) =>
      q.query(`update clinical.consents set withdrawn_at = now()
                where index_case_id = $1 and purpose = 'advisory_issue'`, [kase.id]));

    await assert.rejects(repo.issueAdvisory(ctxPhysicianA, advisoryId), /CONSENT_MISSING/);
  });

  test('the full path draft -> sign -> issue does work', async () => {
    const { kase } = await makeReadyCase();
    const { advisoryId } = await draftFor(kase.id);
    const signed = await repo.signAdvisory(ctxPhysicianA, advisoryId);
    assert.ok(signed.contentHash.length === 64);
    const issued = await repo.issueAdvisory(ctxPhysicianA, advisoryId);
    assert.equal(issued.status, 'issued');
    const row = await repo.getAdvisory(ctxPhysicianA, advisoryId);
    assert.equal(row?.status, 'issued');
    assert.ok(row?.issued_at, 'issued_at is stamped by the trigger');
    assert.equal(row?.signed_by_name, 'Dr A. Narayanan');
  });
});

describe('who may sign', () => {
  test('a counsellor cannot sign, whatever the application layer thinks', async () => {
    const { kase } = await makeReadyCase();
    const { advisoryId } = await draftFor(kase.id);
    await assert.rejects(
      asUser(ctxCounsellorA, async (q) =>
        q.query(
          `insert into clinical.advisory_signoffs
             (advisory_id, signed_by, registration_no, registration_body, signature_hash)
           values ($1,$2,'FAKE','NMC','x')`, [advisoryId, ctxCounsellorA.userId])),
      /row-level security|policy/i);
  });

  test('a physician with no registration number cannot sign', async () => {
    const { kase } = await makeReadyCase();
    const { advisoryId } = await draftFor(kase.id);
    await assert.rejects(repo.signAdvisory(ctxUnregisteredA, advisoryId),
      /SIGNATORY_NOT_REGISTERED/);
    await assert.rejects(
      asUser(ctxUnregisteredA, async (q) =>
        q.query(
          `insert into clinical.advisory_signoffs
             (advisory_id, signed_by, registration_no, registration_body, signature_hash)
           values ($1,$2,'BORROWED-NUMBER','NMC','x')`,
          [advisoryId, ctxUnregisteredA.userId])),
      /row-level security|policy/i,
      'supplying a registration number in the insert must not create authority to sign');
  });

  test('a clinician cannot sign on another clinician’s behalf', async () => {
    const { kase } = await makeReadyCase();
    const { advisoryId } = await draftFor(kase.id);
    await assert.rejects(
      asUser(ctxPharmacistA, async (q) =>
        q.query(
          `insert into clinical.advisory_signoffs
             (advisory_id, signed_by, registration_no, registration_body, signature_hash)
           values ($1,$2,'NMC-DEMO-10001','NMC','x')`,
          [advisoryId, ctxPhysicianA.userId])),
      /row-level security|policy/i);
  });

  test('a clinician at another hospital cannot sign this advisory', async () => {
    const { kase } = await makeReadyCase();
    const { advisoryId } = await draftFor(kase.id);
    await assert.rejects(repo.signAdvisory(ctxPhysicianB, advisoryId), /ADVISORY_NOT_FOUND/);
  });

  test('an advisory can be signed only once', async () => {
    const { kase } = await makeReadyCase();
    const { advisoryId } = await draftFor(kase.id);
    await repo.signAdvisory(ctxPhysicianA, advisoryId);
    await assert.rejects(repo.signAdvisory(ctxPharmacistA, advisoryId), /ADVISORY_NOT_DRAFT/);
  });

  test('a clinical pharmacist with a registration number may sign', async () => {
    const { kase } = await makeReadyCase();
    const { advisoryId } = await draftFor(kase.id);
    const signed = await repo.signAdvisory(ctxPharmacistA, advisoryId);
    assert.ok(signed.contentHash);
  });
});

describe('what signing actually does to the document', () => {
  test('the draft carries no signature, and says so', async () => {
    const { kase } = await makeReadyCase();
    const { rendered } = await draftFor(kase.id);
    const sig = rendered.clinical.blocks.find((b) => b.key === 'signatory')!;
    assert.match(JSON.stringify(sig.body), /unsigned draft/);
  });

  test('signing re-renders the document under the SIGNER’s name', async () => {
    const { kase } = await makeReadyCase();
    const { advisoryId, rendered: draft } = await draftFor(kase.id);
    // Drafted by the physician, signed by the pharmacist.
    const signed = await repo.signAdvisory(ctxPharmacistA, advisoryId);
    const sig = signed.rendered.clinical.blocks.find((b) => b.key === 'signatory')!;
    assert.match(JSON.stringify(sig.body), /S\. Iyer/);
    assert.match(JSON.stringify(sig.body), /PCI-DEMO-20002/);
    assert.ok(!/unsigned draft/.test(JSON.stringify(sig.body)));
    assert.notEqual(signed.contentHash, draft.contentHash,
      'the hash must change: a different document was signed');
  });

  test('the signature hash binds the signer to that exact content', async () => {
    const { kase } = await makeReadyCase();
    const { advisoryId } = await draftFor(kase.id);
    const signed = await repo.signAdvisory(ctxPhysicianA, advisoryId);
    const row = await asUser(ctxPhysicianA, async (q) =>
      (await q.query<{ signature_hash: string }>(
        `select signature_hash from clinical.advisory_signoffs where advisory_id = $1`,
        [advisoryId])).rows[0]);
    const { sha256 } = await import('../src/knowledge/hash.ts');
    assert.equal(row.signature_hash,
      sha256([advisoryId, ctxPhysicianA.userId, 'NMC-DEMO-10001', signed.contentHash].join('|')));
  });

  test('signed content is frozen: correcting it means superseding, not editing', async () => {
    const { kase } = await makeReadyCase();
    const { advisoryId } = await draftFor(kase.id);
    await repo.signAdvisory(ctxPhysicianA, advisoryId);
    await assert.rejects(
      asUser(ctxPhysicianA, async (q) =>
        q.query(
          `update clinical.advisories set content_clinical = '{"tampered":true}'::jsonb
            where id = $1`, [advisoryId])),
      /ADVISORY_IMMUTABLE/);
  });

  test('issued content is frozen too', async () => {
    const { kase } = await makeReadyCase();
    const { advisoryId } = await draftFor(kase.id);
    await repo.signAdvisory(ctxPhysicianA, advisoryId);
    await repo.issueAdvisory(ctxPhysicianA, advisoryId);
    await assert.rejects(
      asUser(ctxPhysicianA, async (q) =>
        q.query(`update clinical.advisories set content_hash = 'forged' where id = $1`,
          [advisoryId])),
      /ADVISORY_IMMUTABLE/);
  });

  test('an advisory cannot be deleted, only revoked', async () => {
    const { kase } = await makeReadyCase();
    const { advisoryId } = await draftFor(kase.id);
    await assert.rejects(
      asUser(ctxPhysicianA, async (q) =>
        q.query(`delete from clinical.advisories where id = $1`, [advisoryId])),
      /permission denied|row-level security|policy/i);

    await repo.signAdvisory(ctxPhysicianA, advisoryId);
    await repo.issueAdvisory(ctxPhysicianA, advisoryId);
    await repo.revokeAdvisory(ctxPhysicianA, advisoryId, 'superseded by a corrected report');
    assert.equal((await repo.getAdvisory(ctxPhysicianA, advisoryId))?.status, 'revoked');
  });
});

describe('the two-person rule on genotype entry', () => {
  test('the user who entered a result cannot verify it', async () => {
    const { result } = await makeReadyCase({ verify: false });
    await assert.rejects(repo.verifyGenotypeResult(ctxPharmacistA, result.id),
      /GENOTYPE_SELF_VERIFICATION/);
  });

  test('the database refuses self-verification even if the service layer is bypassed', async () => {
    const { result } = await makeReadyCase({ verify: false });
    await assert.rejects(
      asUser(ctxPharmacistA, async (q) =>
        q.query(
          `update clinical.genotype_results set verified_by = $2, verified_at = now()
            where id = $1`, [result.id, ctxPharmacistA.userId])),
      /verifier_is_second_person|check constraint/i);
  });

  test('an unverified genotype blocks the whole pathway at G5', async () => {
    const { kase } = await makeReadyCase({ verify: false });
    const ev = await repo.runEvaluation(ctxPhysicianA, { indexCaseId: kase.id, policy: POLICY });
    assert.equal(ev.result.decision, 'BLOCK');
    assert.ok(ev.result.reasonCodes.includes('GENOTYPE_UNVERIFIED'));
  });

  test('a second registered user can verify, and the pathway then proceeds', async () => {
    const { kase, result } = await makeReadyCase({ verify: false });
    await repo.verifyGenotypeResult(ctxPhysicianA, result.id);
    const ev = await repo.runEvaluation(ctxPhysicianA, { indexCaseId: kase.id, policy: POLICY });
    assert.equal(ev.result.decision, 'ADVISORY_DRAFT');
  });
});

describe('a draft is only ever created from a decision that permits one', () => {
  test('no advisory can be drafted from a BLOCK', async () => {
    const { kase } = await makeReadyCase({ verify: false });
    const ev = await repo.runEvaluation(ctxPhysicianA, { indexCaseId: kase.id, policy: POLICY });
    await assert.rejects(
      repo.createAdvisoryDraft(ctxPhysicianA, {
        indexCaseId: kase.id, evaluationId: ev.evaluationId, result: ev.result }),
      /ADVISORY_NOT_PERMITTED/);
  });

  test('no advisory can be drafted from a negative result', async () => {
    const { kase } = await makeReadyCase({ diplotype: '*40:06/*44:03' });
    const ev = await repo.runEvaluation(ctxPhysicianA, { indexCaseId: kase.id, policy: POLICY });
    assert.equal(ev.result.decision, 'NO_ACTION');
    await assert.rejects(
      repo.createAdvisoryDraft(ctxPhysicianA, {
        indexCaseId: kase.id, evaluationId: ev.evaluationId, result: ev.result }),
      /ADVISORY_NOT_PERMITTED/);
  });
});
