/**
 * The clinical service layer.
 *
 * Every function here runs as an authenticated application user, inside a
 * transaction, under row-level security. None of them bypasses it. If a
 * query in this file can read another organisation's data, the policies in
 * 005_rls.sql are wrong and the test suite should be failing.
 */
import { asUser, type Queryer, type UserContext } from './client.ts';
import { audit } from './audit.ts';
import { encryptMrn, hashMrn } from './identifiers.ts';
import { evaluate } from '../engine/engine.ts';
import { getActiveRulePack } from '../knowledge/rule-pack.ts';
import { renderAdvisory } from '../render/advisory.ts';
import { sha256 } from '../knowledge/hash.ts';
import type {
  ConsentState, EnginePolicy, EvaluationResult, ReactionType, WhoUmc,
} from '../engine/types.ts';

export interface Ctx extends UserContext { orgId: string; }

async function requireUser(q: Queryer, userId: string) {
  const r = await q.query<{ org_id: string; full_name: string; role: string;
    registration_no: string | null; registration_body: string | null }>(
    `select org_id, full_name, role, registration_no, registration_body
       from clinical.app_users where id = $1`, [userId]);
  if (r.rows.length === 0) throw new Error('USER_NOT_VISIBLE: no such user in this context');
  return r.rows[0];
}

// ---------------------------------------------------------------------
// Index cases and consent
// ---------------------------------------------------------------------
export interface NewIndexCase {
  mrn: string;
  yearOfBirth?: number | null;
  sex?: string | null;
  state?: string | null;
  preferredLanguage?: string | null;
}

export async function createIndexCase(ctx: Ctx, input: NewIndexCase) {
  return asUser(ctx, async (q) => {
    const r = await q.query<{ id: string; family_link_token: string }>(
      `insert into clinical.index_cases
         (org_id, mrn_hash, mrn_encrypted, year_of_birth, sex, state,
          preferred_language, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       returning id, family_link_token`,
      [ctx.orgId, hashMrn(input.mrn, ctx.orgId), encryptMrn(input.mrn),
       input.yearOfBirth ?? null, input.sex ?? null, input.state ?? null,
       input.preferredLanguage ?? null, ctx.userId]);
    await audit(q, ctx, {
      action: 'index_case.create', objectType: 'index_case', objectId: r.rows[0].id,
    });
    return r.rows[0];
  });
}

export async function recordConsent(
  ctx: Ctx,
  input: { indexCaseId: string; purpose: string; granted: boolean;
           language: string; documentRef?: string | null },
) {
  return asUser(ctx, async (q) => {
    const r = await q.query<{ id: string }>(
      `insert into clinical.consents
         (index_case_id, purpose, granted, language, document_ref, witnessed_by)
       values ($1,$2,$3,$4,$5,$6) returning id`,
      [input.indexCaseId, input.purpose, input.granted, input.language,
       input.documentRef ?? null, ctx.userId]);
    await audit(q, ctx, {
      action: 'consent.record', objectType: 'consent', objectId: r.rows[0].id,
      detail: { purpose: input.purpose, granted: input.granted },
    });
    return r.rows[0];
  });
}

export async function withdrawConsent(ctx: Ctx, consentId: string) {
  return asUser(ctx, async (q) => {
    await q.query(
      `update clinical.consents set withdrawn_at = now() where id = $1`, [consentId]);
    await audit(q, ctx, {
      action: 'consent.withdraw', objectType: 'consent', objectId: consentId });
  });
}

async function consentState(q: Queryer, indexCaseId: string): Promise<ConsentState> {
  const r = await q.query<{ purpose: string }>(
    `select purpose from clinical.consents
      where index_case_id = $1 and granted and withdrawn_at is null`, [indexCaseId]);
  const on = new Set(r.rows.map((x) => x.purpose));
  return {
    genotyping: on.has('genotyping'),
    advisory_issue: on.has('advisory_issue'),
    counselling: on.has('counselling'),
    registry_deidentified: on.has('registry_deidentified'),
    recontact: on.has('recontact'),
  };
}

// ---------------------------------------------------------------------
// ADR events
// ---------------------------------------------------------------------
export async function createAdrEvent(
  ctx: Ctx,
  input: {
    indexCaseId: string; suspectDrug: string; reactionType: ReactionType;
    onsetDate?: string | null; latencyDays?: number | null;
    causalityWhoUmc?: WhoUmc; vigiflowRef?: string | null; outcome?: string | null;
  },
) {
  return asUser(ctx, async (q) => {
    const assessed = input.causalityWhoUmc && input.causalityWhoUmc !== 'not_assessed';
    const r = await q.query<{ id: string }>(
      `insert into clinical.adr_events
         (index_case_id, org_id, suspect_drug, reaction_type, onset_date,
          latency_days, causality_who_umc, causality_assessed_by,
          causality_assessed_at, vigiflow_ref, outcome)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
      [input.indexCaseId, ctx.orgId, input.suspectDrug, input.reactionType,
       input.onsetDate ?? null, input.latencyDays ?? null,
       input.causalityWhoUmc ?? 'not_assessed',
       assessed ? ctx.userId : null, assessed ? new Date().toISOString() : null,
       input.vigiflowRef ?? null, input.outcome ?? null]);
    await audit(q, ctx, {
      action: 'adr_event.create', objectType: 'adr_event', objectId: r.rows[0].id,
      detail: { reaction_type: input.reactionType,
                causality: input.causalityWhoUmc ?? 'not_assessed' },
    });
    return r.rows[0];
  });
}

export async function assessCausality(ctx: Ctx, adrEventId: string, causality: WhoUmc) {
  return asUser(ctx, async (q) => {
    await q.query(
      `update clinical.adr_events
          set causality_who_umc = $2, causality_assessed_by = $3,
              causality_assessed_at = now()
        where id = $1`, [adrEventId, causality, ctx.userId]);
    await audit(q, ctx, {
      action: 'adr_event.assess_causality', objectType: 'adr_event',
      objectId: adrEventId, detail: { causality },
    });
  });
}

// ---------------------------------------------------------------------
// Genotype orders and results -- gate G5
// ---------------------------------------------------------------------
export async function orderGenotype(
  ctx: Ctx,
  input: { indexCaseId: string; adrEventId?: string | null; geneSymbol: string;
           labName?: string | null; labAccreditation?: string | null },
) {
  return asUser(ctx, async (q) => {
    const r = await q.query<{ id: string }>(
      `insert into clinical.genotype_orders
         (index_case_id, adr_event_id, gene_symbol, ordered_by, lab_name, lab_accreditation)
       values ($1,$2,$3,$4,$5,$6) returning id`,
      [input.indexCaseId, input.adrEventId ?? null, input.geneSymbol, ctx.userId,
       input.labName ?? null, input.labAccreditation ?? null]);
    await audit(q, ctx, {
      action: 'genotype.order', objectType: 'genotype_order', objectId: r.rows[0].id,
      detail: { gene: input.geneSymbol },
    });
    return r.rows[0];
  });
}

export async function enterGenotypeResult(
  ctx: Ctx,
  input: {
    orderId: string; indexCaseId: string; geneSymbol: string; diplotype: string;
    method: string; labName: string; labAccreditation: string; reportRef: string;
    resultedAt: string;
  },
) {
  return asUser(ctx, async (q) => {
    const r = await q.query<{ id: string }>(
      `insert into clinical.genotype_results
         (order_id, index_case_id, gene_symbol, diplotype, method, lab_name,
          lab_accreditation, report_ref, resulted_at, entered_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [input.orderId, input.indexCaseId, input.geneSymbol, input.diplotype,
       input.method, input.labName, input.labAccreditation, input.reportRef,
       input.resultedAt, ctx.userId]);
    await q.query(
      `update clinical.genotype_orders set status = 'resulted' where id = $1`,
      [input.orderId]);
    await audit(q, ctx, {
      action: 'genotype.enter_result', objectType: 'genotype_result',
      objectId: r.rows[0].id, detail: { gene: input.geneSymbol, verified: false },
    });
    return r.rows[0];
  });
}

/**
 * Two-person verification. A transcription error in a genotype is a
 * catastrophic failure mode: it can route a carrier back onto the drug that
 * nearly killed them. The database constraint blocks self-verification; this
 * check exists so the caller gets a comprehensible error rather than a
 * constraint violation.
 */
export async function verifyGenotypeResult(ctx: Ctx, resultId: string) {
  return asUser(ctx, async (q) => {
    const existing = await q.query<{ entered_by: string }>(
      `select entered_by from clinical.genotype_results where id = $1`, [resultId]);
    if (existing.rows.length === 0) throw new Error('GENOTYPE_RESULT_NOT_FOUND');
    if (existing.rows[0].entered_by === ctx.userId) {
      throw new Error(
        'GENOTYPE_SELF_VERIFICATION: the user who entered a genotype result ' +
        'cannot be the user who verifies it.');
    }
    await q.query(
      `update clinical.genotype_results
          set verified_by = $2, verified_at = now() where id = $1`,
      [resultId, ctx.userId]);
    await audit(q, ctx, {
      action: 'genotype.verify', objectType: 'genotype_result', objectId: resultId,
      detail: { verified: true },
    });
  });
}

// ---------------------------------------------------------------------
// Evaluation -- runs the engine and records the result, blocks included
// ---------------------------------------------------------------------
export interface EvaluationRecord {
  evaluationId: string;
  result: EvaluationResult;
}

export async function runEvaluation(
  ctx: Ctx,
  input: { indexCaseId: string; adrEventId?: string | null; policy?: Partial<EnginePolicy> },
): Promise<EvaluationRecord> {
  const rulePack = await getActiveRulePack();

  return asUser(ctx, async (q) => {
    const adr = input.adrEventId
      ? (await q.query<Record<string, unknown>>(
          `select * from clinical.adr_events where id = $1`, [input.adrEventId])).rows[0]
      : (await q.query<Record<string, unknown>>(
          `select * from clinical.adr_events where index_case_id = $1
            order by created_at desc limit 1`, [input.indexCaseId])).rows[0];

    const gt = (await q.query<Record<string, unknown>>(
      `select * from clinical.genotype_results where index_case_id = $1
        order by resulted_at desc limit 1`, [input.indexCaseId])).rows[0];

    const result = evaluate({
      now: new Date(),
      rulePack,
      adrEvent: adr ? {
        suspectDrug: adr.suspect_drug as string,
        reactionType: adr.reaction_type as ReactionType,
        causalityWhoUmc: adr.causality_who_umc as WhoUmc,
        onsetDate: adr.onset_date as string | null,
        latencyDays: adr.latency_days as number | null,
        vigiflowRef: adr.vigiflow_ref as string | null,
      } : null,
      consents: await consentState(q, input.indexCaseId),
      genotypeResult: gt ? {
        geneSymbol: gt.gene_symbol as string,
        diplotype: gt.diplotype as string,
        method: gt.method as string,
        labName: gt.lab_name as string,
        labAccreditation: gt.lab_accreditation as string,
        reportRef: gt.report_ref as string,
        resultedAt: new Date(gt.resulted_at as string).toISOString(),
        verified: gt.verified_by !== null,
      } : null,
      policy: input.policy,
    });

    // Blocks are recorded, never discarded. They are the most valuable
    // audit data in the system and the best pilot metric available.
    const row = await q.query<{ id: string }>(
      `insert into clinical.eligibility_evaluations
         (index_case_id, org_id, adr_event_id, genotype_result_id, rule_pack_version,
          decision, reason_codes, gate_trace, engine_version, evaluated_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [input.indexCaseId, ctx.orgId, adr?.id ?? null, gt?.id ?? null,
       result.rulePackVersion ?? 'none', result.decision, result.reasonCodes,
       JSON.stringify(result.gateTrace), result.engineVersion, ctx.userId]);

    await audit(q, ctx, {
      action: 'evaluation.run', objectType: 'eligibility_evaluation',
      objectId: row.rows[0].id,
      reasonCodes: result.reasonCodes,
      detail: { decision: result.decision, rule_pack: result.rulePackVersion ?? 'none' },
    });

    return { evaluationId: row.rows[0].id, result };
  });
}

// ---------------------------------------------------------------------
// Advisories
// ---------------------------------------------------------------------
export async function createAdvisoryDraft(
  ctx: Ctx,
  input: {
    indexCaseId: string; evaluationId: string; result: EvaluationResult;
    recipientSummary?: Array<{ relationshipType: string; count: number }>;
    policy?: Partial<EnginePolicy>;
  },
) {
  const rulePack = await getActiveRulePack();
  if (!rulePack) throw new Error('RULE_PACK_MISSING: cannot draft without an active rule pack');
  if (input.result.decision !== 'ADVISORY_DRAFT' || !input.result.finding) {
    throw new Error(
      `ADVISORY_NOT_PERMITTED: the engine returned ${input.result.decision}. ` +
      `A draft is created only from an ADVISORY_DRAFT decision.`);
  }

  return asUser(ctx, async (q) => {
    const user = await requireUser(q, ctx.userId);
    const org = await q.query<{ name: string }>(
      `select name from clinical.organizations where id = $1`, [ctx.orgId]);
    const gt = (await q.query<Record<string, unknown>>(
      `select * from clinical.genotype_results where index_case_id = $1
        order by resulted_at desc limit 1`, [input.indexCaseId])).rows[0];
    const kase = (await q.query<{ preferred_language: string | null }>(
      `select preferred_language from clinical.index_cases where id = $1`,
      [input.indexCaseId])).rows[0];

    // The draft is rendered with the DRAFTING user's name, and re-rendered
    // at sign-off with the SIGNING clinician's. A document must never carry
    // a signature block belonging to someone who did not sign it.
    const rendered = renderAdvisory({
      evaluation: input.result,
      rulePack,
      signatory: {
        fullName: `${user.full_name} (unsigned draft)`,
        registrationNo: user.registration_no ?? 'not recorded',
        registrationBody: user.registration_body ?? 'not recorded',
      },
      issuedOn: new Date(),
      organisationName: org.rows[0]?.name ?? 'unknown',
      labName: gt.lab_name as string,
      labAccreditation: gt.lab_accreditation as string,
      method: gt.method as string,
      reportRef: gt.report_ref as string,
      resultedAt: new Date(gt.resulted_at as string).toISOString(),
      preferredLanguage: kase?.preferred_language ?? 'en',
      recipientSummary: input.recipientSummary,
    });

    const f = input.result.finding;
    const row = await q.query<{ id: string }>(
      `insert into clinical.advisories
         (index_case_id, evaluation_id, org_id, status, rule_pack_version,
          guideline_citation, guideline_version, india_evidence_tier,
          content_clinical, content_patient, content_hash)
       values ($1,$2,$3,'draft',$4,$5,$6,$7,$8,$9,$10) returning id`,
      [input.indexCaseId, input.evaluationId, ctx.orgId, rulePack.version,
       f.pair.guidelineCitation, f.pair.guidelineVersion, f.indiaEvidenceTier,
       JSON.stringify(rendered.clinical), JSON.stringify(rendered.patient),
       rendered.contentHash]);

    for (const r of input.recipientSummary ?? []) {
      await q.query(
        `insert into clinical.advisory_recipient_summary
           (advisory_id, relationship_type, count) values ($1,$2,$3)
         on conflict (advisory_id, relationship_type) do update set count = excluded.count`,
        [row.rows[0].id, r.relationshipType, r.count]);
    }

    await audit(q, ctx, {
      action: 'advisory.draft', objectType: 'advisory', objectId: row.rows[0].id,
      detail: { rule_pack: rulePack.version, tier: f.indiaEvidenceTier },
    });
    return { advisoryId: row.rows[0].id, rendered };
  });
}

/**
 * Sign-off. Gate G8, outside the engine, in the application, by a named
 * clinician. The document is re-rendered so that the signature block holds
 * the signing clinician's own name and registration number, and the content
 * hash is recomputed over what was actually signed.
 */
export async function signAdvisory(ctx: Ctx, advisoryId: string) {
  const rulePack = await getActiveRulePack();
  if (!rulePack) throw new Error('RULE_PACK_MISSING');

  return asUser(ctx, async (q) => {
    const user = await requireUser(q, ctx.userId);
    if (!user.registration_no) {
      throw new Error(
        'SIGNATORY_NOT_REGISTERED: a clinician without a registration number cannot sign.');
    }

    const adv = (await q.query<Record<string, unknown>>(
      `select * from clinical.advisories where id = $1`, [advisoryId])).rows[0];
    if (!adv) throw new Error('ADVISORY_NOT_FOUND');
    if (adv.status !== 'draft') {
      throw new Error(`ADVISORY_NOT_DRAFT: status is ${adv.status}`);
    }

    const evaluation = (await q.query<{ decision: string; gate_trace: unknown }>(
      `select decision from clinical.eligibility_evaluations where id = $1`,
      [adv.evaluation_id as string])).rows[0];
    if (evaluation?.decision !== 'ADVISORY_DRAFT') {
      throw new Error('ADVISORY_EVALUATION_INVALID: the evaluation no longer permits an advisory');
    }

    const org = await q.query<{ name: string }>(
      `select name from clinical.organizations where id = $1`, [ctx.orgId]);
    const gt = (await q.query<Record<string, unknown>>(
      `select * from clinical.genotype_results where index_case_id = $1
        order by resulted_at desc limit 1`, [adv.index_case_id as string])).rows[0];
    const kase = (await q.query<{ preferred_language: string | null }>(
      `select preferred_language from clinical.index_cases where id = $1`,
      [adv.index_case_id as string])).rows[0];
    const recipients = (await q.query<{ relationship_type: string; count: number }>(
      `select relationship_type, count from clinical.advisory_recipient_summary
        where advisory_id = $1`, [advisoryId])).rows;

    // Re-run the engine so that a pack that expired between drafting and
    // signing stops the signature, rather than being signed from a stale draft.
    const fresh = evaluate({
      now: new Date(),
      rulePack,
      adrEvent: await (async () => {
        const a = (await q.query<Record<string, unknown>>(
          `select * from clinical.adr_events where index_case_id = $1
            order by created_at desc limit 1`, [adv.index_case_id as string])).rows[0];
        return a ? {
          suspectDrug: a.suspect_drug as string,
          reactionType: a.reaction_type as ReactionType,
          causalityWhoUmc: a.causality_who_umc as WhoUmc,
        } : null;
      })(),
      consents: await consentState(q, adv.index_case_id as string),
      genotypeResult: gt ? {
        geneSymbol: gt.gene_symbol as string,
        diplotype: gt.diplotype as string,
        method: gt.method as string,
        labName: gt.lab_name as string,
        labAccreditation: gt.lab_accreditation as string,
        reportRef: gt.report_ref as string,
        resultedAt: new Date(gt.resulted_at as string).toISOString(),
        verified: gt.verified_by !== null,
      } : null,
      policy: { allowDemonstrationPack: true },
    });
    if (fresh.decision !== 'ADVISORY_DRAFT' || !fresh.finding) {
      throw new Error(
        `ADVISORY_REEVALUATION_FAILED: re-running the engine at sign-off returned ` +
        `${fresh.decision} (${fresh.reasonCodes.join(', ')}). Nothing is signed.`);
    }

    const rendered = renderAdvisory({
      evaluation: fresh,
      rulePack,
      signatory: {
        fullName: user.full_name,
        registrationNo: user.registration_no,
        registrationBody: user.registration_body ?? 'not recorded',
      },
      issuedOn: new Date(),
      organisationName: org.rows[0]?.name ?? 'unknown',
      labName: gt!.lab_name as string,
      labAccreditation: gt!.lab_accreditation as string,
      method: gt!.method as string,
      reportRef: gt!.report_ref as string,
      resultedAt: new Date(gt!.resulted_at as string).toISOString(),
      preferredLanguage: kase?.preferred_language ?? 'en',
      recipientSummary: recipients.map((r) => ({
        relationshipType: r.relationship_type, count: Number(r.count) })),
    });

    await q.query(
      `update clinical.advisories
          set content_clinical = $2, content_patient = $3, content_hash = $4,
              status = 'signed'
        where id = $1`,
      [advisoryId, JSON.stringify(rendered.clinical),
       JSON.stringify(rendered.patient), rendered.contentHash]);

    const signatureHash = sha256(
      [advisoryId, ctx.userId, user.registration_no, rendered.contentHash].join('|'));

    await q.query(
      `insert into clinical.advisory_signoffs
         (advisory_id, signed_by, registration_no, registration_body, signature_hash)
       values ($1,$2,$3,$4,$5)`,
      [advisoryId, ctx.userId, user.registration_no,
       user.registration_body ?? 'not recorded', signatureHash]);

    await audit(q, ctx, {
      action: 'advisory.sign', objectType: 'advisory', objectId: advisoryId,
      detail: { content_hash: rendered.contentHash.slice(0, 32) },
    });
    return { advisoryId, contentHash: rendered.contentHash, rendered };
  });
}

/** Issue. The database trigger is the real gate; this is the front door. */
export async function issueAdvisory(ctx: Ctx, advisoryId: string) {
  return asUser(ctx, async (q) => {
    await q.query(
      `update clinical.advisories set status = 'issued', issued_at = now() where id = $1`,
      [advisoryId]);
    await audit(q, ctx, {
      action: 'advisory.issue', objectType: 'advisory', objectId: advisoryId });
    return { advisoryId, status: 'issued' };
  });
}

export async function revokeAdvisory(ctx: Ctx, advisoryId: string, reason: string) {
  return asUser(ctx, async (q) => {
    await q.query(
      `update clinical.advisories
          set status = 'revoked', revoked_at = now(), revocation_reason = $2
        where id = $1`, [advisoryId, reason]);
    await audit(q, ctx, {
      action: 'advisory.revoke', objectType: 'advisory', objectId: advisoryId });
  });
}

export async function getAdvisory(ctx: Ctx, advisoryId: string) {
  return asUser(ctx, async (q) => {
    const r = await q.query<Record<string, unknown>>(
      `select a.*, s.signed_at, s.registration_no, u.full_name as signed_by_name
         from clinical.advisories a
         left join clinical.advisory_signoffs s on s.advisory_id = a.id
         left join clinical.app_users u on u.id = s.signed_by
        where a.id = $1`, [advisoryId]);
    return r.rows[0] ?? null;
  });
}

// ---------------------------------------------------------------------
// Counselling
// ---------------------------------------------------------------------
export async function recordCounselling(
  ctx: Ctx,
  input: {
    indexCaseId: string; advisoryId?: string | null; language: string;
    topicsCovered: string[]; durationMin?: number | null; notes?: string | null;
  },
) {
  return asUser(ctx, async (q) => {
    const topics = input.topicsCovered.includes('right_not_to_know')
      ? input.topicsCovered
      : [...input.topicsCovered, 'right_not_to_know'];
    const r = await q.query<{ id: string }>(
      `insert into clinical.counselling_records
         (index_case_id, advisory_id, counselled_by, language, topics_covered,
          duration_min, notes)
       values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [input.indexCaseId, input.advisoryId ?? null, ctx.userId, input.language,
       topics, input.durationMin ?? null, input.notes ?? null]);
    await audit(q, ctx, {
      action: 'counselling.record', objectType: 'counselling_record',
      objectId: r.rows[0].id, detail: { topics_n: topics.length },
    });
    return r.rows[0];
  });
}

// ---------------------------------------------------------------------
// Self-presenting relatives: their own subject, their own consent.
// ---------------------------------------------------------------------
export async function registerSelfReferral(
  ctx: Ctx,
  input: { ownIndexCaseId: string; presentedToken?: string | null; declinedInformation?: boolean },
) {
  return asUser(ctx, async (q) => {
    const r = await q.query<{ id: string }>(
      `insert into clinical.self_referred_individuals
         (org_id, own_index_case_id, presented_family_link_token, own_consent_at,
          declined_information)
       values ($1,$2,$3, now(), $4) returning id`,
      [ctx.orgId, input.ownIndexCaseId, input.presentedToken ?? null,
       input.declinedInformation ?? false]);
    await audit(q, ctx, {
      action: 'self_referral.register', objectType: 'self_referred_individual',
      objectId: r.rows[0].id,
      detail: { token_presented: Boolean(input.presentedToken),
                declined: Boolean(input.declinedInformation) },
    });
    return r.rows[0];
  });
}

export async function listEvaluations(ctx: Ctx, indexCaseId?: string) {
  return asUser(ctx, async (q) => {
    const r = indexCaseId
      ? await q.query(`select * from clinical.eligibility_evaluations
                        where index_case_id = $1 order by evaluated_at desc`, [indexCaseId])
      : await q.query(`select * from clinical.eligibility_evaluations
                        order by evaluated_at desc limit 200`);
    return r.rows;
  });
}
