/**
 * HTTP layer: a REST API for the AMC module, a CDS Hooks service for the
 * EHR, and the static operator screen.
 *
 * AUTHENTICATION IN THIS BUILD IS A DEMONSTRATION SHIM. The caller asserts
 * a user identifier in a header. That is adequate for a concept build on
 * localhost and is NOT authentication. A deployment needs SMART on FHIR /
 * OIDC for the EHR path and the hospital's own identity provider for the
 * operator path, with the resulting subject claim driving `auth.uid()`
 * exactly as it does here. See docs/CORRECTIONS.md.
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_ROOT, asService, asUser, closeDb } from '../db/client.ts';
import { migrate } from '../db/migrate.ts';
import * as repo from '../db/repo.ts';
import { getActiveRulePack, listRulePacks, citationVerificationSummary, checkIntegrity } from '../knowledge/rule-pack.ts';
import { REASON_CODES } from '../engine/reason-codes.ts';
import { DISCOVERY, patientViewCards, orderSignCards } from './cds-hooks.ts';
import { documentToHtml } from '../render/html.ts';
import { advisoryPdf, pdfIsPossible } from '../render/document-to-pdf.ts';
import { RenderRefused, formatViolations } from '../render/linter.ts';
import { exportToRegistry, publishAggregate, pilotEndpoints } from '../registry/export.ts';
import { FIGURES } from '../../db/seed/context-figures.ts';
import { DEFAULT_POLICY, INDIA_TIER_DEFINITIONS } from '../engine/types.ts';
import type { RenderedDocument } from '../render/advisory.ts';

const PORT = Number(process.env.PORT ?? 8787);
const UI_DIR = path.join(PROJECT_ROOT, 'src', 'ui');

/** The demonstration rule pack is explicitly opted into, and said out loud. */
const DEMO_POLICY = { allowDemonstrationPack: true };

/**
 * Standard counselling topics offered by the form.
 *
 * `right_not_to_know` is mandatory: the schema has a CHECK constraint that
 * refuses a counselling record without it, and the form marks it so nobody
 * meets that constraint as an error message.
 */
const COUNSELLING_TOPICS = [
  { value: 'variant_meaning', label: 'What the variant does and does not mean', mandatory: false },
  { value: 'drugs_to_avoid', label: 'Which drugs to avoid, and that alternatives exist', mandatory: false },
  { value: 'non_determinism', label: 'Carrying the variant is not a prognosis', mandatory: false },
  { value: 'familial_probability', label: 'Roughly 50% probability for each first-degree relative', mandatory: false },
  { value: 'right_not_to_know', label: 'Relatives may decline to be tested or informed', mandatory: true },
  { value: 'sharing_is_voluntary', label: 'Sharing the advisory is the patient\u2019s decision alone', mandatory: false },
  { value: 'alternatives', label: 'Alternatives and their own cautions', mandatory: false },
  { value: 'negative_not_clearance', label: 'A negative result does not establish absence of risk', mandatory: false },
];

class HttpError extends Error {
  status: number;
  payload: unknown;
  constructor(status: number, message: string, payload?: unknown) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

async function body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new HttpError(413, 'REQUEST_TOO_LARGE');
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'INVALID_JSON');
  }
}

async function requireCtx(req: http.IncomingMessage): Promise<repo.Ctx> {
  const userId = String(req.headers['x-pct-user'] ?? '').trim();
  if (!userId) throw new HttpError(401, 'NO_USER: set the x-pct-user header (demonstration shim).');
  const row = await asService(async (db) =>
    (await db.query<{ org_id: string }>(
      `select org_id from clinical.app_users where id = $1 and is_active`, [userId])).rows[0]);
  if (!row) throw new HttpError(401, 'UNKNOWN_USER');
  return { userId, orgId: row.org_id };
}

function json(res: http.ServerResponse, status: number, data: unknown) {
  const b = Buffer.from(JSON.stringify(data, null, 2));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': b.length,
    'cache-control': 'no-store',
  });
  res.end(b);
}

function send(res: http.ServerResponse, status: number, type: string, data: Buffer | string) {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
  res.writeHead(status, { 'content-type': type, 'content-length': b.length, 'cache-control': 'no-store' });
  res.end(b);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
};

// =====================================================================
const routes: Array<{
  method: string;
  pattern: RegExp;
  handler: (ctxArgs: {
    req: http.IncomingMessage; res: http.ServerResponse;
    params: string[]; url: URL;
  }) => Promise<void>;
}> = [];

function route(method: string, pattern: RegExp, handler: (typeof routes)[number]['handler']) {
  routes.push({ method, pattern, handler });
}

// ---- meta -----------------------------------------------------------
route('GET', /^\/api\/health$/, async ({ res }) => {
  const pack = await getActiveRulePack();
  json(res, 200, {
    status: 'ok',
    rulePack: pack ? {
      version: pack.version,
      provenanceStatus: pack.provenanceStatus,
      expiresAt: pack.expiresAt,
      integrity: checkIntegrity(pack),
    } : null,
    notice: 'CONCEPT BUILD. Not deployed, not validated, no regulatory approval.',
  });
});

route('GET', /^\/api\/session$/, async ({ req, res }) => {
  const ctx = await requireCtx(req);
  const row = await asUser(ctx, async (q) =>
    (await q.query<Record<string, unknown>>(
      `select u.id, u.full_name, u.role, u.registration_no, u.registration_body,
              o.name as org_name, o.amc_code, o.state,
              clinical.can_sign(u.id) as can_sign
         from clinical.app_users u join clinical.organizations o on o.id = u.org_id
        where u.id = $1`, [ctx.userId])).rows[0]);
  json(res, 200, row);
});

/** Demo only: lists the seeded users so the screen can switch between them. */
route('GET', /^\/api\/demo\/users$/, async ({ res }) => {
  const rows = await asService(async (db) =>
    (await db.query(
      `select u.id, u.full_name, u.role, u.registration_no, o.name as org_name,
              clinical.can_sign(u.id) as can_sign
         from clinical.app_users u join clinical.organizations o on o.id = u.org_id
        order by o.amc_code, u.role, u.full_name`)).rows);
  json(res, 200, rows);
});

route('GET', /^\/api\/rule-packs$/, async ({ res }) => {
  const packs = await listRulePacks();
  const active = await getActiveRulePack();
  json(res, 200, {
    packs,
    citations: active ? await citationVerificationSummary(active.version) : null,
    integrity: active ? checkIntegrity(active) : null,
  });
});

route('GET', /^\/api\/reason-codes$/, async ({ res }) => json(res, 200, REASON_CODES));
route('GET', /^\/api\/figures$/, async ({ res }) =>
  json(res, 200, { figures: FIGURES, indiaTiers: INDIA_TIER_DEFINITIONS }));

/**
 * Reference data for the data-entry forms.
 *
 * Enum members and CHECK constraint values are read out of the database
 * rather than restated here, so a form physically cannot offer a value the
 * schema would reject. Drug names, genes and diplotypes come from the
 * active rule pack for the same reason.
 *
 * Gate-relevant policy travels with them, so a form can show which choices
 * will pass and which will block. A coordinator should be able to see that
 * "possible" causality stops the pathway BEFORE they choose it, rather than
 * discovering it from a refusal afterwards.
 */
route('GET', /^\/api\/reference$/, async ({ req, res }) => {
  await requireCtx(req);
  const pack = await getActiveRulePack();

  const { enums, checks } = await asService(async (db) => {
    const e = await db.query<{ typname: string; enumlabel: string }>(
      `select t.typname, e.enumlabel
         from pg_type t
         join pg_enum e on e.enumtypid = t.oid
         join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = 'clinical'
        order by t.typname, e.enumsortorder`);

    // Pull the permitted values straight out of the CHECK constraint text.
    const c = await db.query<{ table_name: string; def: string }>(
      `select cl.relname as table_name, pg_get_constraintdef(co.oid) as def
         from pg_constraint co
         join pg_class cl on cl.oid = co.conrelid
         join pg_namespace n on n.oid = cl.relnamespace
        where n.nspname = 'clinical' and co.contype = 'c'`);

    const byTable: Record<string, string[]> = {};
    for (const row of c.rows) {
      if (!/relationship_type|status/.test(row.def)) continue;
      const values = [...row.def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]);
      if (values.length > 1) byTable[row.table_name] = values;
    }

    const byType: Record<string, string[]> = {};
    for (const row of e.rows) (byType[row.typname] ??= []).push(row.enumlabel);
    return { enums: byType, checks: byTable };
  });

  const policy = DEFAULT_POLICY;

  json(res, 200, {
    reactionTypes: (enums.reaction_type ?? []).map((value) => ({
      value,
      inScope: (policy.inScopeReactions as readonly string[]).includes(value),
    })),
    causalityGrades: (enums.who_umc ?? []).map((value) => ({
      value,
      sufficient: (policy.sufficientCausality as readonly string[]).includes(value),
    })),
    consentPurposes: enums.consent_purpose ?? [],
    relationshipTypes: checks.advisory_recipient_summary ?? [],
    orderStatuses: checks.genotype_orders ?? [],
    genes: (pack?.genes ?? []).map((g) => g.symbol),
    drugs: (pack?.drugs ?? []).map((d) => ({
      name: d.name,
      synonyms: d.synonyms ?? [],
      inCascadeScope: (pack?.pairs ?? []).some(
        (pr) => pr.drugName === d.name && pr.inCascadeScope),
    })),
    diplotypes: (pack?.diplotypes ?? []).map((d) => {
      const ph = (pack?.phenotypes ?? []).find((p) => p.id === d.phenotypeId);
      return {
        diplotype: d.diplotype,
        gene: d.geneSymbol,
        phenotype: ph?.term ?? 'unknown',
        isRisk: ph?.isRiskPhenotype ?? false,
      };
    }),
    // Free text in the schema. Offered as suggestions, never as a closed list,
    // because laboratories report methods inconsistently.
    methods: ['PCR-SSP', 'PCR-SSO', 'TaqMan real-time PCR', 'Sanger sequencing', 'NGS'],
    accreditations: ['NABL', 'CAP', 'none recorded'].map((value) => ({
      value,
      accepted: policy.acceptedAccreditations.some(
        (a) => a.toLowerCase() === value.toLowerCase()),
    })),
    outcomes: ['recovered', 'recovering', 'not recovered', 'recovered with sequelae',
               'fatal', 'unknown'],
    counsellingTopics: COUNSELLING_TOPICS,
    policy: {
      acceptedAccreditations: policy.acceptedAccreditations,
      requireIndependentVerification: policy.requireIndependentVerification,
      genotypeMaxAgeDays: policy.genotypeMaxAgeDays,
    },
  });
});

// ---- cases ----------------------------------------------------------
route('GET', /^\/api\/cases$/, async ({ req, res }) => {
  const ctx = await requireCtx(req);
  const rows = await asUser(ctx, async (q) =>
    (await q.query(`
      select c.id, c.year_of_birth, c.sex, c.state, c.preferred_language,
             c.created_at, c.family_link_token,
             (select count(*) from clinical.consents k
               where k.index_case_id = c.id and k.granted and k.withdrawn_at is null) as consents,
             (select a.suspect_drug from clinical.adr_events a
               where a.index_case_id = c.id order by a.created_at desc limit 1) as suspect_drug,
             (select a.reaction_type from clinical.adr_events a
               where a.index_case_id = c.id order by a.created_at desc limit 1) as reaction_type,
             (select a.causality_who_umc from clinical.adr_events a
               where a.index_case_id = c.id order by a.created_at desc limit 1) as causality,
             (select g.diplotype from clinical.genotype_results g
               where g.index_case_id = c.id order by g.resulted_at desc limit 1) as diplotype,
             (select g.verified_by is not null from clinical.genotype_results g
               where g.index_case_id = c.id order by g.resulted_at desc limit 1) as genotype_verified,
             (select e.decision from clinical.eligibility_evaluations e
               where e.index_case_id = c.id order by e.evaluated_at desc limit 1) as last_decision
        from clinical.index_cases c order by c.created_at desc limit 100`)).rows);
  json(res, 200, rows);
});

route('POST', /^\/api\/cases$/, async ({ req, res }) => {
  const ctx = await requireCtx(req);
  const b = await body(req);
  if (!b.mrn) throw new HttpError(400, 'MRN_REQUIRED');
  json(res, 201, await repo.createIndexCase(ctx, {
    mrn: String(b.mrn),
    yearOfBirth: b.yearOfBirth ? Number(b.yearOfBirth) : null,
    sex: b.sex ? String(b.sex) : null,
    state: b.state ? String(b.state) : null,
    preferredLanguage: b.preferredLanguage ? String(b.preferredLanguage) : null,
  }));
});

route('GET', /^\/api\/cases\/([0-9a-f-]{36})$/, async ({ req, res, params }) => {
  const ctx = await requireCtx(req);
  const detail = await asUser(ctx, async (q) => {
    const [kase, consents, adrs, orders, results, evals, advisories, counselling] =
      await Promise.all([
        q.query(`select * from clinical.index_cases where id = $1`, [params[0]]),
        q.query(`select * from clinical.consents where index_case_id = $1 order by granted_at`, [params[0]]),
        q.query(`select * from clinical.adr_events where index_case_id = $1 order by created_at desc`, [params[0]]),
        q.query(`select * from clinical.genotype_orders where index_case_id = $1 order by ordered_at desc`, [params[0]]),
        q.query(`select * from clinical.genotype_results where index_case_id = $1 order by resulted_at desc`, [params[0]]),
        q.query(`select * from clinical.eligibility_evaluations where index_case_id = $1 order by evaluated_at desc`, [params[0]]),
        q.query(`select a.*, s.signed_at, u.full_name as signed_by_name, s.registration_no
                   from clinical.advisories a
                   left join clinical.advisory_signoffs s on s.advisory_id = a.id
                   left join clinical.app_users u on u.id = s.signed_by
                  where a.index_case_id = $1 order by a.created_at desc`, [params[0]]),
        q.query(`select * from clinical.counselling_records where index_case_id = $1`, [params[0]]),
      ]);
    if (kase.rows.length === 0) return null;
    return {
      case: kase.rows[0], consents: consents.rows, adrEvents: adrs.rows,
      genotypeOrders: orders.rows, genotypeResults: results.rows,
      evaluations: evals.rows, advisories: advisories.rows, counselling: counselling.rows,
    };
  });
  if (!detail) throw new HttpError(404, 'CASE_NOT_FOUND');
  json(res, 200, detail);
});

route('POST', /^\/api\/cases\/([0-9a-f-]{36})\/consents$/, async ({ req, res, params }) => {
  const ctx = await requireCtx(req);
  const b = await body(req);
  json(res, 201, await repo.recordConsent(ctx, {
    indexCaseId: params[0], purpose: String(b.purpose),
    granted: b.granted !== false, language: String(b.language ?? 'en'),
    documentRef: b.documentRef ? String(b.documentRef) : null,
  }));
});

route('POST', /^\/api\/consents\/([0-9a-f-]{36})\/withdraw$/, async ({ req, res, params }) => {
  const ctx = await requireCtx(req);
  await repo.withdrawConsent(ctx, params[0]);
  json(res, 200, { withdrawn: true });
});

route('POST', /^\/api\/cases\/([0-9a-f-]{36})\/adr-events$/, async ({ req, res, params }) => {
  const ctx = await requireCtx(req);
  const b = await body(req);
  json(res, 201, await repo.createAdrEvent(ctx, {
    indexCaseId: params[0],
    suspectDrug: String(b.suspectDrug ?? ''),
    reactionType: String(b.reactionType ?? 'SJS') as never,
    onsetDate: b.onsetDate ? String(b.onsetDate) : null,
    latencyDays: b.latencyDays ? Number(b.latencyDays) : null,
    causalityWhoUmc: (b.causalityWhoUmc ? String(b.causalityWhoUmc) : 'not_assessed') as never,
    vigiflowRef: b.vigiflowRef ? String(b.vigiflowRef) : null,
    outcome: b.outcome ? String(b.outcome) : null,
  }));
});

route('POST', /^\/api\/adr-events\/([0-9a-f-]{36})\/causality$/, async ({ req, res, params }) => {
  const ctx = await requireCtx(req);
  const b = await body(req);
  await repo.assessCausality(ctx, params[0], String(b.causality) as never);
  json(res, 200, { assessed: true });
});

route('POST', /^\/api\/cases\/([0-9a-f-]{36})\/genotype-orders$/, async ({ req, res, params }) => {
  const ctx = await requireCtx(req);
  const b = await body(req);
  json(res, 201, await repo.orderGenotype(ctx, {
    indexCaseId: params[0], adrEventId: b.adrEventId ? String(b.adrEventId) : null,
    geneSymbol: String(b.geneSymbol ?? 'HLA-B'),
    labName: b.labName ? String(b.labName) : null,
    labAccreditation: b.labAccreditation ? String(b.labAccreditation) : null,
  }));
});

route('POST', /^\/api\/genotype-orders\/([0-9a-f-]{36})\/results$/, async ({ req, res, params }) => {
  const ctx = await requireCtx(req);
  const b = await body(req);
  json(res, 201, await repo.enterGenotypeResult(ctx, {
    orderId: params[0], indexCaseId: String(b.indexCaseId),
    geneSymbol: String(b.geneSymbol ?? 'HLA-B'), diplotype: String(b.diplotype ?? ''),
    method: String(b.method ?? 'PCR-SSP'), labName: String(b.labName ?? ''),
    labAccreditation: String(b.labAccreditation ?? ''), reportRef: String(b.reportRef ?? ''),
    resultedAt: String(b.resultedAt ?? new Date().toISOString()),
  }));
});

route('POST', /^\/api\/genotype-results\/([0-9a-f-]{36})\/verify$/, async ({ req, res, params }) => {
  const ctx = await requireCtx(req);
  await repo.verifyGenotypeResult(ctx, params[0]);
  json(res, 200, { verified: true });
});

// ---- the engine -----------------------------------------------------
route('POST', /^\/api\/cases\/([0-9a-f-]{36})\/evaluate$/, async ({ req, res, params }) => {
  const ctx = await requireCtx(req);
  const b = await body(req);
  const out = await repo.runEvaluation(ctx, {
    indexCaseId: params[0],
    adrEventId: b.adrEventId ? String(b.adrEventId) : null,
    policy: { ...DEMO_POLICY, ...(b.policy as object ?? {}) },
  });
  json(res, 200, out);
});

// ---- advisories -----------------------------------------------------
route('POST', /^\/api\/advisories$/, async ({ req, res }) => {
  const ctx = await requireCtx(req);
  const b = await body(req);
  const ev = await repo.runEvaluation(ctx, {
    indexCaseId: String(b.indexCaseId), policy: DEMO_POLICY });
  const out = await repo.createAdvisoryDraft(ctx, {
    indexCaseId: String(b.indexCaseId),
    evaluationId: ev.evaluationId,
    result: ev.result,
    recipientSummary: (b.recipientSummary as Array<{ relationshipType: string; count: number }>) ?? [],
  });
  json(res, 201, { advisoryId: out.advisoryId, evaluation: ev.result });
});

route('POST', /^\/api\/advisories\/([0-9a-f-]{36})\/sign$/, async ({ req, res, params }) => {
  const ctx = await requireCtx(req);
  const out = await repo.signAdvisory(ctx, params[0]);
  json(res, 200, { advisoryId: out.advisoryId, contentHash: out.contentHash });
});

route('POST', /^\/api\/advisories\/([0-9a-f-]{36})\/issue$/, async ({ req, res, params }) => {
  const ctx = await requireCtx(req);
  json(res, 200, await repo.issueAdvisory(ctx, params[0]));
});

route('POST', /^\/api\/advisories\/([0-9a-f-]{36})\/revoke$/, async ({ req, res, params }) => {
  const ctx = await requireCtx(req);
  const b = await body(req);
  await repo.revokeAdvisory(ctx, params[0], String(b.reason ?? 'not stated'));
  json(res, 200, { revoked: true });
});

route('GET', /^\/api\/advisories\/([0-9a-f-]{36})$/, async ({ req, res, params }) => {
  const ctx = await requireCtx(req);
  const row = await repo.getAdvisory(ctx, params[0]);
  if (!row) throw new HttpError(404, 'ADVISORY_NOT_FOUND');
  json(res, 200, row);
});

/**
 * Documents. An advisory that has not been signed does not render to a
 * document at all: nothing prints and nothing leaves the system until a
 * named clinician has signed it.
 */
async function advisoryDocument(
  req: http.IncomingMessage, advisoryId: string, which: 'clinical' | 'patient',
): Promise<{ doc: RenderedDocument; row: Record<string, unknown> }> {
  const ctx = await requireCtx(req);
  const row = await repo.getAdvisory(ctx, advisoryId);
  if (!row) throw new HttpError(404, 'ADVISORY_NOT_FOUND');
  if (row.status === 'draft') {
    throw new HttpError(409, 'ADVISORY_UNSIGNED',
      { detail: 'Nothing prints until a named clinician signs. Sign the advisory first.' });
  }
  const doc = (which === 'clinical' ? row.content_clinical : row.content_patient) as RenderedDocument;
  return { doc, row };
}

for (const which of ['clinical', 'patient'] as const) {
  route('GET', new RegExp(`^/api/advisories/([0-9a-f-]{36})/${which}\\.html$`),
    async ({ req, res, params }) => {
      const { doc, row } = await advisoryDocument(req, params[0], which);
      send(res, 200, 'text/html; charset=utf-8',
        documentToHtml(doc,
          `Rule pack ${row.rule_pack_version} · India Evidence Tier ${row.india_evidence_tier} · status ${row.status}`));
    });

  route('GET', new RegExp(`^/api/advisories/([0-9a-f-]{36})/${which}\\.pdf$`),
    async ({ req, res, params }) => {
      const { doc, row } = await advisoryDocument(req, params[0], which);
      if (!pdfIsPossible(doc)) {
        throw new HttpError(415, 'PDF_UNSUPPORTED_SCRIPT', {
          detail:
            'This document uses a script the built-in PDF fonts cannot represent. ' +
            'The HTML rendering is served instead of a corrupted document.',
          alternative: `/api/advisories/${params[0]}/${which}.html`,
        });
      }
      send(res, 200, 'application/pdf',
        advisoryPdf(doc, `Rule pack ${row.rule_pack_version}, tier ${row.india_evidence_tier}`));
    });
}

route('POST', /^\/api\/cases\/([0-9a-f-]{36})\/counselling$/, async ({ req, res, params }) => {
  const ctx = await requireCtx(req);
  const b = await body(req);
  json(res, 201, await repo.recordCounselling(ctx, {
    indexCaseId: params[0],
    advisoryId: b.advisoryId ? String(b.advisoryId) : null,
    language: String(b.language ?? 'en'),
    topicsCovered: (b.topicsCovered as string[]) ?? [],
    durationMin: b.durationMin ? Number(b.durationMin) : null,
    notes: b.notes ? String(b.notes) : null,
  }));
});

route('POST', /^\/api\/self-referrals$/, async ({ req, res }) => {
  const ctx = await requireCtx(req);
  const b = await body(req);
  json(res, 201, await repo.registerSelfReferral(ctx, {
    ownIndexCaseId: String(b.ownIndexCaseId),
    presentedToken: b.presentedToken ? String(b.presentedToken) : null,
    declinedInformation: Boolean(b.declinedInformation),
  }));
});

// ---- registry -------------------------------------------------------
route('POST', /^\/api\/registry\/export$/, async ({ req, res }) => {
  const ctx = await requireCtx(req);
  const b = await body(req);
  json(res, 200, await exportToRegistry({
    runBy: ctx.userId,
    dryRun: b.dryRun !== false,
    suppressionThreshold: b.suppressionThreshold ? Number(b.suppressionThreshold) : undefined,
  }));
});

route('GET', /^\/api\/registry\/aggregate$/, async ({ req, res, url }) => {
  await requireCtx(req);
  const groupBy = (url.searchParams.get('groupBy') ?? 'state').split(',').map((s) => s.trim());
  const threshold = url.searchParams.get('threshold');
  json(res, 200, await publishAggregate(groupBy as never,
    threshold ? { threshold: Number(threshold) } : {}));
});

route('GET', /^\/api\/registry\/endpoints$/, async ({ req, res, url }) => {
  await requireCtx(req);
  const threshold = url.searchParams.get('threshold');
  json(res, 200, await pilotEndpoints(threshold ? { threshold: Number(threshold) } : {}));
});

// ---- CDS Hooks ------------------------------------------------------
route('GET', /^\/cds-services$/, async ({ res }) => json(res, 200, DISCOVERY));

route('POST', /^\/cds-services\/pct-index-case-review$/, async ({ req, res, url }) => {
  const ctx = await requireCtx(req);
  const b = await body(req);
  const context = (b.context ?? {}) as Record<string, unknown>;
  const patientId = String(context.patientId ?? '');
  if (!patientId) throw new HttpError(400, 'MISSING_PATIENT_CONTEXT');
  const base = `${url.protocol}//${url.host}`;
  json(res, 200, { cards: await patientViewCards(ctx, patientId, base) });
});

route('POST', /^\/cds-services\/pct-prescribing-check$/, async ({ req, res }) => {
  const ctx = await requireCtx(req);
  const b = await body(req);
  const context = (b.context ?? {}) as Record<string, unknown>;
  const patientId = String(context.patientId ?? '');
  if (!patientId) throw new HttpError(400, 'MISSING_PATIENT_CONTEXT');

  // Accept either a plain list of names (demo) or a FHIR Bundle of
  // MedicationRequest resources (what a real EHR sends).
  let drugs: string[] = [];
  if (Array.isArray(context.medications)) {
    drugs = (context.medications as unknown[]).map(String);
  } else if (context.draftOrders && typeof context.draftOrders === 'object') {
    const bundle = context.draftOrders as { entry?: Array<{ resource?: Record<string, unknown> }> };
    drugs = (bundle.entry ?? []).flatMap((e) => {
      const cc = (e.resource?.medicationCodeableConcept ?? {}) as
        { text?: string; coding?: Array<{ display?: string }> };
      return [cc.text, ...(cc.coding ?? []).map((c) => c.display)].filter(Boolean) as string[];
    });
  }
  json(res, 200, { cards: await orderSignCards(ctx, patientId, drugs) });
});

// ---- static UI ------------------------------------------------------
route('GET', /^\/(?:index\.html)?$/, async ({ res }) => {
  send(res, 200, MIME['.html'], await fs.readFile(path.join(UI_DIR, 'index.html')));
});

route('GET', /^\/(app\.js|styles\.css)$/, async ({ res, params }) => {
  const file = path.join(UI_DIR, params[0]);
  if (!file.startsWith(UI_DIR)) throw new HttpError(403, 'FORBIDDEN');
  send(res, 200, MIME[path.extname(file)] ?? 'application/octet-stream',
    await fs.readFile(file));
});

// =====================================================================
export function createServer(): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    try {
      for (const r of routes) {
        if (r.method !== (req.method ?? 'GET')) continue;
        const m = r.pattern.exec(url.pathname);
        if (!m) continue;
        await r.handler({ req, res, params: m.slice(1), url });
        return;
      }
      json(res, 404, { error: 'NOT_FOUND', path: url.pathname });
    } catch (err) {
      if (err instanceof HttpError) {
        json(res, err.status, { error: err.message, ...(err.payload as object ?? {}) });
        return;
      }
      if (err instanceof RenderRefused) {
        // The linter refusing is a correct, reportable outcome, not a crash.
        json(res, 422, {
          error: 'RENDER_REFUSED',
          profile: err.profile,
          violations: err.violations,
          report: formatViolations(err.violations),
        });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      const code = /^([A-Z][A-Z0-9_]{3,}):/.exec(message)?.[1];
      // A named, expected refusal is a 409. Anything else is a 500 and is
      // logged, because an unexplained failure in a safety pathway is a defect.
      if (code) { json(res, 409, { error: code, detail: message }); return; }
      console.error('[pct] unhandled', err);
      json(res, 500, { error: 'INTERNAL', detail: message });
    }
  });
}

if (import.meta.filename === process.argv[1]) {
  await migrate();
  const pack = await getActiveRulePack();
  const server = createServer();
  server.listen(PORT, () => {
    console.log(`\n  PCT concept build listening on http://localhost:${PORT}`);
    console.log(`  Rule pack: ${pack ? `${pack.version} (${pack.provenanceStatus})` : 'NONE LOADED - run: npm run seed'}`);
    console.log(`  CDS Hooks discovery: http://localhost:${PORT}/cds-services`);
    console.log(`\n  Nothing here is deployed, validated, or approved by any regulator.\n`);
  });
  const shutdown = async () => { server.close(); await closeDb(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
