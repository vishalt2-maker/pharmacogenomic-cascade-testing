/**
 * CDS HOOKS SERVICE.
 *
 * Why this and not a browser extension, stated plainly because it comes up
 * in every hospital IT review: a DOM-scraping extension reading clinical
 * text is indiscriminate surveillance of everything the user types, sits on
 * the most exploited surface in the hospital, and carries supply-chain risk
 * through its update channel. CDS Hooks with SMART on FHIR is the
 * recognised standard for injecting decision support into clinical
 * workflow. It is permissioned, auditable and scoped to the moment it is
 * asked to act.
 *
 * SCOPE OF THIS BUILD: the discovery document and card shapes follow the
 * CDS Hooks specification. Resolving `context.patientId` against a real
 * FHIR server, and validating the JWT a real EHR sends in the
 * Authorization header, are NOT implemented here. Both are required before
 * this touches a hospital. See docs/CORRECTIONS.md.
 */
import { evaluate } from '../engine/engine.ts';
import { getActiveRulePack } from '../knowledge/rule-pack.ts';
import { reason } from '../engine/reason-codes.ts';
import { asUser } from '../db/client.ts';
import type { Ctx } from '../db/repo.ts';
import type { ReactionType, WhoUmc } from '../engine/types.ts';

export const DISCOVERY = {
  services: [
    {
      hook: 'patient-view',
      id: 'pct-index-case-review',
      title: 'Pharmacogenomic cascade: index case review',
      description:
        'Where a severe cutaneous adverse reaction to an aromatic anticonvulsant has been logged for this patient, shows whether the pathway can proceed and, where it cannot, exactly which gate is blocking it.',
      prefetch: {
        patient: 'Patient/{{context.patientId}}',
      },
    },
    {
      hook: 'order-sign',
      id: 'pct-prescribing-check',
      title: 'Pharmacogenomic cascade: prescribing check',
      description:
        'Where a confirmed genotype exists for this patient and a drug in scope is being signed, surfaces the published guidance for the prescriber to consider.',
    },
  ],
};

export interface CdsCard {
  uuid?: string;
  summary: string;
  detail?: string;
  indicator: 'info' | 'warning' | 'critical';
  source: { label: string; url?: string };
  links?: Array<{ label: string; url: string; type: 'absolute' | 'smart' }>;
  overrideReasons?: Array<{ code: string; display: string }>;
}

const SOURCE = {
  label: 'Pharmacogenomic Cascade Testing (concept build)',
};

/**
 * A card never says "the system recommends". It says what the published
 * guidance says, and names who published it. The clinician decides.
 */
export async function patientViewCards(
  ctx: Ctx, patientId: string, baseUrl: string,
): Promise<CdsCard[]> {
  const rulePack = await getActiveRulePack();

  return asUser(ctx, async (q) => {
    const kase = (await q.query<Record<string, unknown>>(
      `select * from clinical.index_cases where id = $1`, [patientId])).rows[0];
    if (!kase) return [];

    const adr = (await q.query<Record<string, unknown>>(
      `select * from clinical.adr_events where index_case_id = $1
        order by created_at desc limit 1`, [patientId])).rows[0];
    if (!adr) return [];

    const gt = (await q.query<Record<string, unknown>>(
      `select * from clinical.genotype_results where index_case_id = $1
        order by resulted_at desc limit 1`, [patientId])).rows[0];

    const consents = (await q.query<{ purpose: string }>(
      `select purpose from clinical.consents
        where index_case_id = $1 and granted and withdrawn_at is null`, [patientId])).rows;
    const on = new Set(consents.map((c) => c.purpose));

    const result = evaluate({
      now: new Date(),
      rulePack,
      adrEvent: {
        suspectDrug: adr.suspect_drug as string,
        reactionType: adr.reaction_type as ReactionType,
        causalityWhoUmc: adr.causality_who_umc as WhoUmc,
      },
      consents: {
        genotyping: on.has('genotyping'),
        advisory_issue: on.has('advisory_issue'),
      },
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

    // No card at all where the pathway simply does not apply. A decision
    // support tool that fires on every patient is a decision support tool
    // that gets switched off.
    if (result.decision === 'NO_ACTION' && !result.negativePathway) return [];

    if (result.decision === 'BLOCK') {
      const primary = result.reasonCodes[0];
      const def = reason(primary);
      return [{
        summary: `Cascade pathway blocked: ${def.message}`,
        detail: [
          `**Gate ${def.gate} stopped this case.**`,
          def.remedy ? `\n${def.remedy}` : '',
          `\nNothing has been produced and nothing has been sent. This is the system working as designed: no confirmed genotype, no cascade.`,
          `\nRule pack: ${result.rulePackVersion ?? 'none'}`,
        ].join('\n'),
        indicator: primary === 'GENOTYPE_REQUIRED' ? 'warning' : 'info',
        source: SOURCE,
        links: [{
          label: 'Open the case in the AMC module',
          url: `${baseUrl}/?case=${patientId}`,
          type: 'absolute',
        }],
      }];
    }

    if (result.negativePathway) {
      return [{
        summary: 'Index genotype does not carry the risk allele. No advisory issued.',
        detail:
          'No familial advisory is produced on a negative result, and the result does not ' +
          'establish absence of risk. Clinical monitoring remains necessary. ' +
          'The result is recorded for the registry.',
        indicator: 'info',
        source: SOURCE,
      }];
    }

    const f = result.finding!;
    return [{
      summary:
        `${f.phenotype.term}. Published guidance: ${f.recommendation.actionCode.replace(/_/g, ' ')} ${f.pair.drugName}.`,
      detail: [
        f.recommendation.clinicalText,
        '',
        `**India Evidence Tier ${f.indiaEvidenceTier}** — ${f.indiaTierDefinition}`,
        `Actionability level ${f.pair.cpicActionability}, which describes whether prescribing should change and is not a level of evidence.`,
        `Recommendation strength: ${f.recommendation.recommendationStrength}.`,
        '',
        `Source: ${f.pair.guidelineCitation}`,
        '',
        'Each first-degree relative has approximately a 50% probability of carrying this variant. That is a probability, not a diagnosis.',
        '',
        'A draft familial advisory is available. It prints only after a named clinician signs it.',
      ].join('\n'),
      indicator: 'critical',
      source: { ...SOURCE, url: f.pair.guidelineUrl },
      links: [{
        label: 'Review and sign the draft advisory',
        url: `${baseUrl}/?case=${patientId}`,
        type: 'absolute',
      }],
    }];
  });
}

/**
 * order-sign: the moment that actually matters. A drug in scope is being
 * signed for a patient with a confirmed genotype.
 */
export async function orderSignCards(
  ctx: Ctx, patientId: string, drugNames: string[],
): Promise<CdsCard[]> {
  const rulePack = await getActiveRulePack();
  if (!rulePack) return [];

  return asUser(ctx, async (q) => {
    const gt = (await q.query<Record<string, unknown>>(
      `select * from clinical.genotype_results where index_case_id = $1
        order by resulted_at desc limit 1`, [patientId])).rows[0];
    if (!gt || gt.verified_by === null) return [];

    const mapping = rulePack.diplotypes.find(
      (d) => d.geneSymbol.toLowerCase() === String(gt.gene_symbol).toLowerCase() &&
             d.diplotype.toLowerCase() === String(gt.diplotype).toLowerCase());
    const phenotype = rulePack.phenotypes.find((p) => p.id === mapping?.phenotypeId);
    if (!phenotype?.isRiskPhenotype) return [];

    const cards: CdsCard[] = [];
    for (const raw of drugNames) {
      const needle = raw.trim().toLowerCase();
      const drug = rulePack.drugs.find(
        (d) => d.name.toLowerCase() === needle ||
               (d.synonyms ?? []).some((s) => s.toLowerCase() === needle));
      if (!drug) continue;

      const pair = rulePack.pairs.find(
        (p) => p.drugName === drug.name &&
               p.geneSymbol.toLowerCase() === String(gt.gene_symbol).toLowerCase());
      const rec = pair && rulePack.recommendations.find(
        (r) => r.pairId === pair.id && r.phenotypeId === phenotype.id);

      if (pair && rec && rec.actionCode === 'avoid_drug') {
        cards.push({
          summary: `${drug.name}: this patient is ${phenotype.term}. Published guidance is to use an alternative.`,
          detail: [
            rec.clinicalText,
            '',
            `India Evidence Tier ${pair.indiaEvidenceTier}. Actionability level ${pair.cpicActionability}.`,
            `Source: ${pair.guidelineCitation}`,
          ].join('\n'),
          indicator: 'critical',
          source: { ...SOURCE, url: pair.guidelineUrl },
          overrideReasons: [
            { code: 'clinically-indicated', display: 'Clinically indicated after review of alternatives' },
            { code: 'already-tolerated', display: 'Patient has tolerated this drug beyond the high-risk window' },
            { code: 'patient-informed', display: 'Risk discussed with the patient, who elects to proceed' },
          ],
        });
        continue;
      }

      // An alternative that carries its own caution is worth a quieter card.
      const cautioned = rulePack.recommendations
        .flatMap((r) => r.alternatives)
        .find((a) => a.drugName === drug.name && a.cautionFlag);
      if (cautioned) {
        cards.push({
          summary: `${drug.name}: a caution is recorded for this drug in ${phenotype.term} individuals.`,
          detail: cautioned.cautionText,
          indicator: 'warning',
          source: SOURCE,
        });
      }
    }
    return cards;
  });
}
