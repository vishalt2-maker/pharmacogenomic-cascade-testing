/**
 * THE SAFETY ENGINE.
 *
 * A deterministic, stateless, pure function. Input: an evaluation context.
 * Output: a decision, a set of reason codes, and the rule pack version used.
 *
 * There is no language model here. No machine learning. No probability the
 * system invented. Every number that reaches an advisory is either a
 * laboratory result or a published figure carried through from a cited
 * source. This is deliberate: in a safety pathway, a tool that produces
 * nothing is safe and a tool that guesses is a hazard.
 *
 * Fail-closed rules, applied without exception:
 *   1. Any unhandled exception BLOCKS with ENGINE_ERROR. Never a default.
 *   2. Any NULL in a gate input is a failure, not an absence of objection.
 *   3. Ambiguity is never resolved by picking the safer-sounding option.
 *      It blocks and names the ambiguity.
 *   4. Every evaluation is recorded, including -- especially -- the blocks.
 *   5. The engine never writes. It returns a decision; the application
 *      layer creates the draft.
 */
import {
  DEFAULT_POLICY,
  INDIA_TIER_DEFINITIONS,
  type Alternative, type EnginePolicy, type EvaluationInput,
  type EvaluationResult, type EvidenceSource, type GateTraceEntry,
  type GeneDrugPair, type IndiaTier, type Phenotype,
  type PopulationFrequency, type Recommendation, type ResolvedFinding,
  type RulePack,
} from './types.ts';
import { computeRulePackHash } from '../knowledge/hash.ts';

export const ENGINE_VERSION = 'pct-safety-engine/1.0.0';

/** Tiers that rest on limited or indirect Indian data. */
const LOW_INDIA_TIERS: ReadonlySet<IndiaTier> = new Set(['IN-3', 'IN-4', 'IN-0']);

/**
 * Internal control flow for a gate that stops evaluation. Not an error in
 * the ordinary sense: a block is a correct, expected outcome, and the most
 * common one in a system whose primary skill is refusing to act.
 */
class GateStop extends Error {
  decision: 'BLOCK' | 'NO_ACTION' | 'INFORM_ONLY';
  codes: string[];
  constructor(decision: 'BLOCK' | 'NO_ACTION' | 'INFORM_ONLY', codes: string[]) {
    super(codes.join(','));
    this.decision = decision;
    this.codes = codes;
  }
}

function blank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Evaluate one case against one rule pack.
 * Pure: no clock, no database, no network. `now` is an input so that every
 * evaluation is reproducible exactly, forever.
 */
export function evaluate(input: EvaluationInput): EvaluationResult {
  const trace: GateTraceEntry[] = [];
  const warnings: string[] = [];
  const policy: EnginePolicy = { ...DEFAULT_POLICY, ...(input.policy ?? {}) };
  const evaluatedAt = (input.now instanceof Date && !Number.isNaN(input.now.getTime()))
    ? input.now.toISOString()
    : new Date(0).toISOString();

  const done = (
    decision: EvaluationResult['decision'],
    codes: string[],
    extra: Partial<EvaluationResult> = {},
  ): EvaluationResult => ({
    decision,
    reasonCodes: [...new Set(codes)],
    warnings: [...new Set(warnings)],
    rulePackVersion: input.rulePack?.version ?? null,
    indiaEvidenceTier: null,
    engineVersion: ENGINE_VERSION,
    gateTrace: trace,
    finding: null,
    negativePathway: false,
    evaluatedAt,
    ...extra,
  });

  const gate = (
    id: string, name: string,
    fn: () => Record<string, unknown>,
  ): Record<string, unknown> => {
    try {
      const detail = fn();
      trace.push({ gate: id, name, status: 'pass', reasonCodes: [], detail });
      return detail;
    } catch (err) {
      if (err instanceof GateStop) {
        trace.push({ gate: id, name, status: 'fail', reasonCodes: err.codes, detail: {} });
      }
      throw err;
    }
  };

  const skip = (id: string, name: string, why: string) => {
    trace.push({ gate: id, name, status: 'skipped', reasonCodes: [], detail: { why } });
  };

  try {
    // =================================================================
    // G0  RULE PACK VALID?
    // =================================================================
    const pack = input.rulePack;
    gate('G0', 'Rule pack valid, active and unexpired', () => {
      if (!pack) throw new GateStop('BLOCK', ['RULE_PACK_MISSING']);
      if (!pack.isActive) throw new GateStop('BLOCK', ['RULE_PACK_INACTIVE']);

      const effective = Date.parse(pack.effectiveFrom);
      const expires = Date.parse(pack.expiresAt);
      const nowMs = input.now instanceof Date ? input.now.getTime() : NaN;
      if (!Number.isFinite(effective) || !Number.isFinite(expires) || !Number.isFinite(nowMs)) {
        throw new GateStop('BLOCK', ['RULE_PACK_INVALID']);
      }
      if (nowMs < effective) throw new GateStop('BLOCK', ['RULE_PACK_NOT_YET_EFFECTIVE']);
      // Expiry is enforced, not advisory.
      if (nowMs >= expires) throw new GateStop('BLOCK', ['RULE_PACK_STALE']);

      // The hash is recomputed over the pack's own content, not trusted.
      const actual = computeRulePackHash(pack);
      if (actual !== pack.contentHash) throw new GateStop('BLOCK', ['RULE_PACK_INVALID']);

      if (pack.provenanceStatus === 'demonstration' && !policy.allowDemonstrationPack) {
        throw new GateStop('BLOCK', ['RULE_PACK_NOT_CLINICALLY_CURATED']);
      }
      if (pack.provenanceStatus !== 'curated_verified') {
        warnings.push('RULE_PACK_CITATIONS_UNVERIFIED');
      }
      const daysLeft = (expires - nowMs) / 86_400_000;
      if (daysLeft <= policy.rulePackWarnWindowDays) {
        warnings.push('RULE_PACK_EXPIRING_SOON');
      }
      return {
        version: pack.version,
        provenanceStatus: pack.provenanceStatus,
        daysToExpiry: Math.floor(daysLeft),
      };
    });
    const rp = pack as RulePack;

    // =================================================================
    // G1  DRUG IN SCOPE?
    // =================================================================
    const g1 = gate('G1', 'Suspect drug is in a gene-drug pair in cascade scope', () => {
      const adr = input.adrEvent;
      if (!adr) throw new GateStop('BLOCK', ['ADR_EVENT_MISSING']);
      if (blank(adr.suspectDrug)) throw new GateStop('BLOCK', ['ADR_DRUG_MISSING']);

      const needle = norm(adr.suspectDrug as string);
      const matches = rp.drugs.filter((d) =>
        norm(d.name) === needle ||
        (d.synonyms ?? []).some((s) => norm(s) === needle));

      if (matches.length === 0) throw new GateStop('NO_ACTION', ['DRUG_OUT_OF_SCOPE']);
      if (matches.length > 1) throw new GateStop('BLOCK', ['DRUG_AMBIGUOUS']);

      const drug = matches[0];
      const pairs = rp.pairs.filter((p) =>
        norm(p.drugName) === norm(drug.name) &&
        (!policy.requireCascadeScope || p.inCascadeScope));
      if (pairs.length === 0) throw new GateStop('NO_ACTION', ['DRUG_OUT_OF_SCOPE']);

      return {
        resolvedDrug: drug.name,
        matchedOn: norm(drug.name) === needle ? 'name' : 'synonym',
        candidatePairs: pairs.map((p) => p.id),
      };
    });
    const candidatePairs: GeneDrugPair[] = rp.pairs.filter(
      (p) => (g1.candidatePairs as string[]).includes(p.id));

    // =================================================================
    // G2  REACTION IN SCOPE?
    // =================================================================
    gate('G2', 'Reaction is a severe cutaneous adverse reaction in scope', () => {
      const rt = input.adrEvent?.reactionType;
      if (blank(rt)) throw new GateStop('BLOCK', ['REACTION_MISSING']);
      if (!policy.inScopeReactions.includes(rt as never)) {
        throw new GateStop('NO_ACTION', ['REACTION_OUT_OF_SCOPE']);
      }
      return { reactionType: rt };
    });

    // =================================================================
    // G3  CAUSALITY SUFFICIENT?
    // Cascade testing starts from a CONFIRMED index case.
    // =================================================================
    gate('G3', 'WHO-UMC causality is probable or certain', () => {
      const c = input.adrEvent?.causalityWhoUmc;
      if (blank(c) || c === 'not_assessed') {
        throw new GateStop('BLOCK', ['CAUSALITY_NOT_ASSESSED']);
      }
      if (!policy.sufficientCausality.includes(c as never)) {
        throw new GateStop('BLOCK', ['CAUSALITY_INSUFFICIENT']);
      }
      return { causality: c };
    });

    // =================================================================
    // G4  CONSENT PRESENT?
    // Separate, explicit consent per purpose. Never a blanket flag.
    // =================================================================
    gate('G4', 'Active consent for genotyping and advisory issue', () => {
      const c = input.consents ?? ({} as never);
      const missing: string[] = [];
      if (c.genotyping !== true) missing.push('genotyping');
      if (c.advisory_issue !== true) missing.push('advisory_issue');
      if (missing.length > 0) {
        throw new GateStop('BLOCK', ['CONSENT_MISSING']);
      }
      return { purposes: ['genotyping', 'advisory_issue'] };
    });

    // =================================================================
    // G5  GENOTYPE CONFIRMED?   <-- THE GATE
    //
    // This is the differentiator. No confirmed index genotype, no family
    // link, nothing to cascade. Demonstrate the system refusing here.
    // =================================================================
    const g5 = gate('G5', 'Confirmed genotype from an accredited laboratory', () => {
      const r = input.genotypeResult;
      if (!r) throw new GateStop('BLOCK', ['GENOTYPE_REQUIRED']);
      if (blank(r.diplotype) || blank(r.geneSymbol) || blank(r.reportRef)) {
        throw new GateStop('BLOCK', ['GENOTYPE_REQUIRED']);
      }
      if (blank(r.labAccreditation) ||
          !policy.acceptedAccreditations
            .some((a) => norm(a) === norm(r.labAccreditation as string))) {
        throw new GateStop('BLOCK', ['LAB_NOT_ACCREDITED']);
      }

      const resulted = Date.parse(r.resultedAt ?? '');
      if (!Number.isFinite(resulted)) {
        throw new GateStop('BLOCK', ['GENOTYPE_RESULT_DATE_INVALID']);
      }
      if (resulted > input.now.getTime()) {
        throw new GateStop('BLOCK', ['GENOTYPE_RESULT_DATE_INVALID']);
      }
      if (policy.genotypeMaxAgeDays !== null) {
        const ageDays = (input.now.getTime() - resulted) / 86_400_000;
        if (ageDays > policy.genotypeMaxAgeDays) {
          throw new GateStop('BLOCK', ['GENOTYPE_RESULT_EXPIRED']);
        }
      }
      if (policy.requireIndependentVerification && r.verified !== true) {
        throw new GateStop('BLOCK', ['GENOTYPE_UNVERIFIED']);
      }

      // The gene reported must match a pair actually under evaluation.
      const pair = candidatePairs.find(
        (p) => norm(p.geneSymbol) === norm(r.geneSymbol as string));
      if (!pair) throw new GateStop('BLOCK', ['GENOTYPE_GENE_MISMATCH']);

      // Other in-scope pairs for this drug that were not tested are worth
      // surfacing, but they do not block: the pair we did test is valid.
      const untested = candidatePairs.filter((p) => p.id !== pair.id);
      if (untested.length > 0) warnings.push('UNTESTED_PAIRS_FOR_DRUG');

      // An unrecognised diplotype BLOCKS. It is never quietly treated as
      // absence of risk.
      const mapping = rp.diplotypes.find(
        (d) => norm(d.geneSymbol) === norm(r.geneSymbol as string) &&
               norm(d.diplotype) === norm(r.diplotype as string));
      if (!mapping) throw new GateStop('BLOCK', ['DIPLOTYPE_UNRECOGNISED']);

      const phenotype = rp.phenotypes.find((p) => p.id === mapping.phenotypeId);
      if (!phenotype) throw new GateStop('BLOCK', ['DIPLOTYPE_UNRECOGNISED']);

      return {
        pairId: pair.id,
        gene: pair.geneSymbol,
        diplotype: r.diplotype,
        phenotype: phenotype.term,
        isRiskPhenotype: phenotype.isRiskPhenotype,
        labAccreditation: r.labAccreditation,
        untestedPairs: untested.map((p) => p.id),
      };
    });

    const pair = candidatePairs.find((p) => p.id === g5.pairId) as GeneDrugPair;
    const phenotype = rp.phenotypes.find(
      (p) => p.term === g5.phenotype && norm(p.geneSymbol) === norm(pair.geneSymbol)) as Phenotype;
    const tier = pair.indiaEvidenceTier;
    if (LOW_INDIA_TIERS.has(tier)) warnings.push('INDIA_EVIDENCE_TIER_LOW');

    // -----------------------------------------------------------------
    // THE NEGATIVE PATHWAY
    //
    // A negative genotype does NOT produce a cleared document. CPIC states
    // that a negative result does not eliminate risk. The v1 default is to
    // issue nothing and record the negative in the registry, because
    // creating a false-reassurance harm pathway that did not previously
    // exist is exactly what regulators look for in decision support.
    // -----------------------------------------------------------------
    if (!phenotype.isRiskPhenotype) {
      skip('G6', 'Recommendation resolvable', 'negative pathway: no advisory is produced');
      skip('G7', 'Actionability threshold', 'negative pathway: no advisory is produced');
      warnings.push('NEGATIVE_DOES_NOT_EXCLUDE_RISK');
      const codes = policy.negativePathway === 'monitoring_reminder'
        ? ['NEGATIVE_MONITORING_REMINDER']
        : ['NEGATIVE_RESULT_NO_ADVISORY'];
      return done(
        policy.negativePathway === 'monitoring_reminder' ? 'INFORM_ONLY' : 'NO_ACTION',
        codes,
        { indiaEvidenceTier: tier, negativePathway: true },
      );
    }

    // =================================================================
    // G6  RECOMMENDATION RESOLVABLE?
    // Exactly one. Zero blocks. More than one blocks and names it.
    // =================================================================
    const recs: Recommendation[] = rp.recommendations.filter(
      (r) => r.pairId === pair.id && r.phenotypeId === phenotype.id);
    gate('G6', 'Exactly one recommendation for this pair and phenotype', () => {
      if (recs.length === 0) throw new GateStop('BLOCK', ['RECOMMENDATION_MISSING']);
      if (recs.length > 1) throw new GateStop('BLOCK', ['RECOMMENDATION_AMBIGUOUS']);
      const bad = recs[0].alternatives.find(
        (a: Alternative) => a.cautionFlag && blank(a.cautionText));
      if (bad) throw new GateStop('BLOCK', ['ALTERNATIVE_CAUTION_MISSING']);
      return { recommendationId: recs[0].id, actionCode: recs[0].actionCode };
    });
    const rec = recs[0];

    // =================================================================
    // G7  ACTIONABILITY THRESHOLD?
    // Actionability is DIMENSION 1 and is not a level of evidence.
    // Mixed levels do not pass: fail-closed means the ambiguous case
    // informs rather than advises.
    // =================================================================
    let decision: EvaluationResult['decision'] = 'ADVISORY_DRAFT';
    const belowThreshold =
      !policy.actionableLevels.includes(pair.cpicActionability) ||
      rec.recommendationStrength === 'no recommendation';

    trace.push({
      gate: 'G7',
      name: 'Gene-drug pair meets the actionability threshold',
      status: belowThreshold ? 'fail' : 'pass',
      reasonCodes: belowThreshold ? ['BELOW_ACTIONABILITY_THRESHOLD'] : [],
      detail: {
        cpicActionability: pair.cpicActionability,
        recommendationStrength: rec.recommendationStrength,
        indiaEvidenceTier: tier,
      },
    });
    if (belowThreshold) decision = 'INFORM_ONLY';

    // G8, clinician sign-off, is deliberately outside the engine. The
    // engine's best possible output is a DRAFT. Nothing prints, and nothing
    // leaves the system, until a named clinician signs.
    skip('G8', 'Named clinician review and sign-off',
      'outside the engine: performed in the application layer. Draft only until signed.');

    const evidence: EvidenceSource[] = rp.evidence.filter(
      (e) => (pair.evidenceIds ?? []).includes(e.id));
    const freqs: PopulationFrequency[] = rp.populationFrequencies.filter(
      (f) => norm(f.geneSymbol) === norm(pair.geneSymbol));

    const finding: ResolvedFinding = {
      pair, phenotype,
      diplotype: g5.diplotype as string,
      recommendation: rec,
      alternatives: rec.alternatives,
      evidence, populationFrequencies: freqs,
      indiaEvidenceTier: tier,
      indiaTierDefinition: INDIA_TIER_DEFINITIONS[tier],
    };

    return done(
      decision,
      belowThreshold ? ['BELOW_ACTIONABILITY_THRESHOLD'] : [],
      { indiaEvidenceTier: tier, finding },
    );
  } catch (err) {
    if (err instanceof GateStop) {
      return done(err.decision, err.codes);
    }
    // Rule 1: never degrade to a default.
    trace.push({
      gate: 'G*', name: 'Engine', status: 'fail',
      reasonCodes: ['ENGINE_ERROR'],
      detail: { error: err instanceof Error ? err.name : 'unknown' },
    });
    return done('BLOCK', ['ENGINE_ERROR']);
  }
}
