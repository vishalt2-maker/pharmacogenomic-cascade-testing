/**
 * HTTP LAYER TESTS: the REST API and the CDS Hooks service.
 *
 * The interesting cases are the refusals. A decision support service that
 * fires a card on every patient gets switched off within a fortnight, and a
 * document endpoint that serves an unsigned draft has defeated the entire
 * sign-off apparatus underneath it.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  setupDb, makeReadyCase, ctxPhysicianA, ctxPharmacistA, ctxCoordinatorA,
  ctxCounsellorA, ctxPhysicianB, USERS,
} from './db-setup.ts';
import * as repo from '../src/db/repo.ts';
import { createServer } from '../src/api/server.ts';
import type { Server } from 'node:http';

let server: Server;
let base: string;

before(async () => {
  await setupDb();
  server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
after(() => { server?.close(); });

async function call(
  path: string, opts: { method?: string; user?: string; body?: unknown } = {},
) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(opts.user ? { 'x-pct-user': opts.user } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const type = res.headers.get('content-type') ?? '';
  const payload = type.includes('json') ? await res.json() : await res.text();
  return { status: res.status, body: payload, type };
}

describe('authentication shim and access', () => {
  test('an unauthenticated request is refused', async () => {
    const r = await call('/api/cases');
    assert.equal(r.status, 401);
  });

  test('an unknown user is refused', async () => {
    const r = await call('/api/cases', { user: '00000000-0000-4000-8000-0000000000ff' });
    assert.equal(r.status, 401);
  });

  test('health is public and states what the build is', async () => {
    const r = await call('/api/health');
    assert.equal(r.status, 200);
    assert.match(r.body.notice, /not validated/i);
    assert.equal(r.body.rulePack.integrity.ok, true);
  });
});

describe('documents are not served before they are signed', () => {
  test('a draft advisory serves NO document, in any format', async () => {
    const { kase } = await makeReadyCase();
    const created = await call('/api/advisories', {
      method: 'POST', user: USERS.physicianA, body: { indexCaseId: kase.id },
    });
    assert.equal(created.status, 201);
    const id = created.body.advisoryId;
    for (const file of ['clinical.html', 'clinical.pdf', 'patient.html', 'patient.pdf']) {
      const r = await call(`/api/advisories/${id}/${file}`, { user: USERS.physicianA });
      assert.equal(r.status, 409, `${file} must not be served for a draft`);
      assert.equal(r.body.error, 'ADVISORY_UNSIGNED');
    }
  });

  test('once signed, documents are served', async () => {
    const { kase } = await makeReadyCase();
    const created = await call('/api/advisories', {
      method: 'POST', user: USERS.physicianA, body: { indexCaseId: kase.id } });
    const id = created.body.advisoryId;
    await call(`/api/advisories/${id}/sign`, { method: 'POST', user: USERS.physicianA, body: {} });

    const html = await call(`/api/advisories/${id}/clinical.html`, { user: USERS.physicianA });
    assert.equal(html.status, 200);
    assert.match(html.body, /India Evidence Tier/);
    assert.match(html.body, /NMC-DEMO-10001/);

    const pdf = await fetch(`${base}/api/advisories/${id}/clinical.pdf`,
      { headers: { 'x-pct-user': USERS.physicianA } });
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  });

  test('a Hindi patient sheet returns a useful refusal for PDF and works as HTML', async () => {
    const made = await repo.createIndexCase(ctxCoordinatorA, {
      mrn: `MRN-HI-${Date.now()}`, preferredLanguage: 'hi', state: 'Maharashtra' });
    for (const purpose of ['genotyping', 'advisory_issue']) {
      await repo.recordConsent(ctxCoordinatorA, {
        indexCaseId: made.id, purpose, granted: true, language: 'hi' });
    }
    await repo.createAdrEvent(ctxCoordinatorA, {
      indexCaseId: made.id, suspectDrug: 'carbamazepine', reactionType: 'SJS',
      causalityWhoUmc: 'probable' });
    const order = await repo.orderGenotype(ctxPhysicianA, {
      indexCaseId: made.id, geneSymbol: 'HLA-B' });
    const res = await repo.enterGenotypeResult(ctxPharmacistA, {
      orderId: order.id, indexCaseId: made.id, geneSymbol: 'HLA-B',
      diplotype: '*15:02/*40:06', method: 'PCR-SSP', labName: 'Demo Genomics Laboratory',
      labAccreditation: 'NABL', reportRef: 'LAB-HI-1',
      resultedAt: new Date(Date.now() - 86400000).toISOString() });
    await repo.verifyGenotypeResult(ctxPhysicianA, res.id);

    const created = await call('/api/advisories', {
      method: 'POST', user: USERS.physicianA, body: { indexCaseId: made.id } });
    const id = created.body.advisoryId;
    await call(`/api/advisories/${id}/sign`, { method: 'POST', user: USERS.physicianA, body: {} });

    const pdf = await call(`/api/advisories/${id}/patient.pdf`, { user: USERS.physicianA });
    assert.equal(pdf.status, 415);
    assert.equal(pdf.body.error, 'PDF_UNSUPPORTED_SCRIPT');
    assert.match(pdf.body.alternative, /patient\.html$/);

    const html = await call(`/api/advisories/${id}/patient.html`, { user: USERS.physicianA });
    assert.equal(html.status, 200);
    assert.match(html.body, /[ऀ-ॿ]/, 'the HTML rendering must carry the Devanagari');
  });

  test('another hospital cannot fetch the document', async () => {
    const { kase } = await makeReadyCase();
    const created = await call('/api/advisories', {
      method: 'POST', user: USERS.physicianA, body: { indexCaseId: kase.id } });
    const id = created.body.advisoryId;
    await call(`/api/advisories/${id}/sign`, { method: 'POST', user: USERS.physicianA, body: {} });
    const r = await call(`/api/advisories/${id}/clinical.html`, { user: USERS.physicianB });
    assert.equal(r.status, 404);
  });
});

describe('the API surfaces refusals as refusals, not as crashes', () => {
  test('drafting from a blocked evaluation returns a named error', async () => {
    const { kase } = await makeReadyCase({ verify: false });
    const r = await call('/api/advisories', {
      method: 'POST', user: USERS.physicianA, body: { indexCaseId: kase.id } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'ADVISORY_NOT_PERMITTED');
  });

  test('a counsellor signing gets a named refusal', async () => {
    const { kase } = await makeReadyCase();
    const created = await call('/api/advisories', {
      method: 'POST', user: USERS.physicianA, body: { indexCaseId: kase.id } });
    const r = await call(`/api/advisories/${created.body.advisoryId}/sign`,
      { method: 'POST', user: USERS.counsellorA, body: {} });
    assert.equal(r.status, 409);
    assert.ok(/SIGNATORY_NOT_REGISTERED|row-level security|policy/i.test(
      `${r.body.error} ${r.body.detail}`));
  });

  test('evaluate returns the full gate trace, including on a block', async () => {
    const { kase } = await makeReadyCase({ verify: false });
    const r = await call(`/api/cases/${kase.id}/evaluate`,
      { method: 'POST', user: USERS.physicianA, body: {} });
    assert.equal(r.status, 200);
    assert.equal(r.body.result.decision, 'BLOCK');
    assert.ok(r.body.result.gateTrace.length >= 5);
    assert.ok(r.body.evaluationId, 'the block is persisted and addressable');
  });

  test('malformed JSON is refused cleanly', async () => {
    const res = await fetch(`${base}/api/cases`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pct-user': USERS.physicianA },
      body: '{not json',
    });
    assert.equal(res.status, 400);
  });

  test('an unknown route is a 404, not a stack trace', async () => {
    const r = await call('/api/nonexistent', { user: USERS.physicianA });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'NOT_FOUND');
  });
});

describe('CDS Hooks', () => {
  test('the discovery document lists both services with the right hooks', async () => {
    const r = await call('/cds-services');
    assert.equal(r.status, 200);
    const hooks = r.body.services.map((s: { hook: string }) => s.hook);
    assert.deepEqual(hooks.sort(), ['order-sign', 'patient-view']);
    for (const s of r.body.services) {
      assert.ok(s.id && s.title && s.description);
    }
  });

  test('patient-view returns NO CARD for a patient with no ADR event', async () => {
    const bare = await repo.createIndexCase(ctxCoordinatorA, { mrn: `MRN-BARE-${Date.now()}` });
    const r = await call('/cds-services/pct-index-case-review', {
      method: 'POST', user: USERS.physicianA,
      body: { hook: 'patient-view', hookInstance: '1', context: { patientId: bare.id } },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.cards, [],
      'a service that fires on every patient is a service that gets switched off');
  });

  test('patient-view explains the block rather than staying silent', async () => {
    const { kase } = await makeReadyCase({ verify: false });
    const r = await call('/cds-services/pct-index-case-review', {
      method: 'POST', user: USERS.physicianA,
      body: { hook: 'patient-view', hookInstance: '1', context: { patientId: kase.id } },
    });
    assert.equal(r.body.cards.length, 1);
    assert.match(r.body.cards[0].summary, /blocked/i);
    assert.match(r.body.cards[0].detail, /Gate G5/);
  });

  test('patient-view on a confirmed carrier is critical and cites the guideline', async () => {
    const { kase } = await makeReadyCase();
    const r = await call('/cds-services/pct-index-case-review', {
      method: 'POST', user: USERS.physicianA,
      body: { hook: 'patient-view', hookInstance: '1', context: { patientId: kase.id } },
    });
    const card = r.body.cards[0];
    assert.equal(card.indicator, 'critical');
    assert.match(card.detail, /India Evidence Tier IN-2/);
    assert.match(card.detail, /not a level of evidence/);
    assert.match(card.detail, /50%/);
    // The card must never claim the software is making the decision.
    assert.ok(!/the system recommends/i.test(card.detail + card.summary));
  });

  test('order-sign reads a FHIR draft-orders bundle and fires on the drug in scope', async () => {
    const { kase } = await makeReadyCase();
    const r = await call('/cds-services/pct-prescribing-check', {
      method: 'POST', user: USERS.physicianA,
      body: {
        hook: 'order-sign', hookInstance: '2',
        context: {
          patientId: kase.id,
          draftOrders: {
            resourceType: 'Bundle',
            entry: [
              { resource: { resourceType: 'MedicationRequest',
                            medicationCodeableConcept: { text: 'Tegretol' } } },
              { resource: { resourceType: 'MedicationRequest',
                            medicationCodeableConcept: { text: 'levetiracetam' } } },
            ],
          },
        },
      },
    });
    assert.equal(r.body.cards.length, 1, 'only the drug in scope should fire');
    assert.equal(r.body.cards[0].indicator, 'critical');
    assert.match(r.body.cards[0].summary, /carbamazepine/);
    assert.ok(r.body.cards[0].overrideReasons.length >= 3,
      'a hard stop with no override path is a hard stop clinicians route around');
  });

  test('order-sign stays silent for a patient with no verified genotype', async () => {
    const { kase } = await makeReadyCase({ verify: false });
    const r = await call('/cds-services/pct-prescribing-check', {
      method: 'POST', user: USERS.physicianA,
      body: { hook: 'order-sign', hookInstance: '3',
              context: { patientId: kase.id, medications: ['carbamazepine'] } },
    });
    assert.deepEqual(r.body.cards, []);
  });

  test('order-sign stays silent for a non-carrier', async () => {
    const { kase } = await makeReadyCase({ diplotype: '*40:06/*44:03' });
    const r = await call('/cds-services/pct-prescribing-check', {
      method: 'POST', user: USERS.physicianA,
      body: { hook: 'order-sign', hookInstance: '4',
              context: { patientId: kase.id, medications: ['carbamazepine'] } },
    });
    assert.deepEqual(r.body.cards, [],
      'a negative result must not generate a reassuring card either');
  });

  test('a missing patient context is refused', async () => {
    const r = await call('/cds-services/pct-index-case-review', {
      method: 'POST', user: USERS.physicianA, body: { hook: 'patient-view', context: {} } });
    assert.equal(r.status, 400);
  });
});
