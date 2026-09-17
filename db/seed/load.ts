/**
 * Load a rule pack into the knowledge schema.
 *
 * Runs as the service role: the knowledge layer is read-only to every
 * application user, and is written only here.
 *
 * The content hash is computed from the pack's own content at load time and
 * stored with it, so the safety engine's gate G0 can recompute and compare
 * rather than trust.
 */
import { asService } from '../../src/db/client.ts';
import { canonicalJson, computeRulePackHash } from '../../src/knowledge/hash.ts';
import type { RulePack } from '../../src/engine/types.ts';

export interface LoadReport {
  version: string;
  contentHash: string;
  counts: Record<string, number>;
  replacedExisting: boolean;
}

export async function loadRulePack(
  pack: RulePack, opts: { activate?: boolean } = {},
): Promise<LoadReport> {
  const contentHash = computeRulePackHash(pack as unknown as Record<string, unknown>);

  return asService(async (db) => {
    await db.exec('begin');
    try {
      const existing = await db.query<{ id: string }>(
        'select id from knowledge.rule_packs where version = $1', [pack.version]);
      const replaced = existing.rows.length > 0;
      if (replaced) {
        // Cascades through every child table: a pack is replaced whole or
        // not at all. Partial packs are how rule sets drift out of sync.
        await db.query('delete from knowledge.rule_packs where version = $1', [pack.version]);
      }

      if (opts.activate !== false) {
        await db.query('update knowledge.rule_packs set is_active = false where is_active');
      }

      const packRow = await db.query<{ id: string }>(
        `insert into knowledge.rule_packs
           (version, cpic_release, source_url, published_at, effective_from,
            expires_at, content_hash, signature, content_json, is_active,
            provenance_status, curated_by, notes)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
        [pack.version, pack.cpicRelease ?? null, pack.sourceUrl ?? null,
         pack.publishedAt, pack.effectiveFrom, pack.expiresAt, contentHash,
         pack.signature ?? null,
         canonicalJson({ ...pack, contentHash }),
         opts.activate !== false, pack.provenanceStatus,
         pack.curatedBy ?? null, pack.notes ?? null]);
      const packId = packRow.rows[0].id;

      const geneIds = new Map<string, string>();
      for (const g of pack.genes) {
        const r = await db.query<{ id: string }>(
          `insert into knowledge.genes (rule_pack_id, symbol, name, clinpgx_id, hgnc_id)
           values ($1,$2,$3,$4,$5) returning id`,
          [packId, g.symbol, g.name ?? null, g.clinpgxId ?? null, g.hgncId ?? null]);
        geneIds.set(g.symbol, r.rows[0].id);
      }

      const alleleIds = new Map<string, string>();
      for (const a of pack.alleles) {
        const r = await db.query<{ id: string }>(
          `insert into knowledge.alleles
             (rule_pack_id, gene_id, allele_name, clinical_function,
              function_evidence, pharmvar_id, activity_value)
           values ($1,$2,$3,$4,$5,$6,$7) returning id`,
          [packId, geneIds.get(a.geneSymbol), a.alleleName, a.clinicalFunction,
           a.functionEvidence ?? null, a.pharmvarId ?? null, null]);
        alleleIds.set(`${a.geneSymbol}|${a.alleleName}`, r.rows[0].id);
      }

      const evidenceIds = new Map<string, string>();
      for (const e of pack.evidence) {
        const r = await db.query<{ id: string }>(
          `insert into knowledge.evidence_sources
             (rule_pack_id, citation, pmid, doi, study_design, population, country,
              case_n, control_n, effect_measure, effect_value, ci_low, ci_high,
              is_indian_cohort, verification_status, verified_url, quality_notes)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           returning id`,
          [packId, e.citation, e.pmid ?? null, e.doi ?? null, e.studyDesign ?? null,
           e.population ?? null, e.country ?? null, e.caseN ?? null, e.controlN ?? null,
           e.effectMeasure ?? null, e.effectValue ?? null, e.ciLow ?? null,
           e.ciHigh ?? null, e.isIndianCohort ?? false, e.verificationStatus,
           e.verifiedUrl ?? null, e.quality_notes ?? null]);
        evidenceIds.set(e.id, r.rows[0].id);
      }

      for (const f of pack.populationFrequencies) {
        await db.query(
          `insert into knowledge.population_frequencies
             (rule_pack_id, allele_id, population, region, allele_freq,
              carrier_freq, sample_n, source_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [packId, alleleIds.get(`${f.geneSymbol}|${f.alleleName}`), f.population,
           f.region ?? null, f.alleleFreq ?? null, f.carrierFreq ?? null,
           f.sampleN ?? null, f.sourceId ? evidenceIds.get(f.sourceId) ?? null : null]);
      }

      const drugIds = new Map<string, string>();
      for (const d of pack.drugs) {
        const r = await db.query<{ id: string }>(
          `insert into knowledge.drugs
             (rule_pack_id, name, rxnorm_id, atc_code, clinpgx_id, is_aromatic_anticonvulsant)
           values ($1,$2,$3,$4,$5,$6) returning id`,
          [packId, d.name, d.rxnormId ?? null, d.atcCode ?? null, d.clinpgxId ?? null,
           d.isAromaticAnticonvulsant ?? false]);
        drugIds.set(d.name, r.rows[0].id);
        for (const s of d.synonyms ?? []) {
          await db.query(
            `insert into knowledge.drug_synonyms (rule_pack_id, drug_id, synonym, synonym_type)
             values ($1,$2,$3,$4)`,
            [packId, r.rows[0].id, s, null]);
        }
      }

      const phenotypeIds = new Map<string, string>();
      for (const p of pack.phenotypes) {
        const r = await db.query<{ id: string }>(
          `insert into knowledge.phenotypes
             (rule_pack_id, gene_id, term, description, is_risk_phenotype)
           values ($1,$2,$3,$4,$5) returning id`,
          [packId, geneIds.get(p.geneSymbol), p.term, p.description ?? null, p.isRiskPhenotype]);
        phenotypeIds.set(p.id, r.rows[0].id);
      }

      for (const d of pack.diplotypes) {
        await db.query(
          `insert into knowledge.diplotype_phenotypes
             (rule_pack_id, gene_id, diplotype, phenotype_id, activity_score)
           values ($1,$2,$3,$4,$5)`,
          [packId, geneIds.get(d.geneSymbol), d.diplotype,
           phenotypeIds.get(d.phenotypeId), d.activityScore ?? null]);
      }

      const pairIds = new Map<string, string>();
      for (const p of pack.pairs) {
        const r = await db.query<{ id: string }>(
          `insert into knowledge.gene_drug_pairs
             (rule_pack_id, gene_id, drug_id, cpic_actionability, evidence_strength,
              india_evidence_tier, india_tier_rationale, guideline_citation,
              guideline_version, guideline_pmid, guideline_doi, guideline_url,
              negative_result_caution, in_cascade_scope)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
          [packId, geneIds.get(p.geneSymbol), drugIds.get(p.drugName),
           p.cpicActionability, p.evidenceStrength ?? null, p.indiaEvidenceTier,
           p.indiaTierRationale ?? null, p.guidelineCitation, p.guidelineVersion,
           p.guidelinePmid ?? null, p.guidelineDoi ?? null, p.guidelineUrl ?? null,
           p.negativeResultCaution, p.inCascadeScope]);
        pairIds.set(p.id, r.rows[0].id);
        for (const evId of p.evidenceIds ?? []) {
          const dbEv = evidenceIds.get(evId);
          if (dbEv) {
            await db.query(
              `insert into knowledge.pair_evidence (gene_drug_pair_id, evidence_id)
               values ($1,$2) on conflict do nothing`, [r.rows[0].id, dbEv]);
          }
        }
      }

      for (const rec of pack.recommendations) {
        const r = await db.query<{ id: string }>(
          `insert into knowledge.recommendations
             (rule_pack_id, gene_drug_pair_id, phenotype_id, action_code,
              recommendation_strength, clinical_text, implications_text, source_table_ref)
           values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
          [packId, pairIds.get(rec.pairId), phenotypeIds.get(rec.phenotypeId),
           rec.actionCode, rec.recommendationStrength, rec.clinicalText,
           rec.implicationsText ?? null, rec.sourceTableRef ?? null]);
        for (const alt of rec.alternatives) {
          await db.query(
            `insert into knowledge.alternatives
               (rule_pack_id, recommendation_id, alternative_drug_id, caution_flag, caution_text)
             values ($1,$2,$3,$4,$5)`,
            [packId, r.rows[0].id, drugIds.get(alt.drugName), alt.cautionFlag,
             alt.cautionText ?? null]);
        }
      }

      for (const w of pack.wordingRules) {
        await db.query(
          `insert into knowledge.wording_rules
             (rule_pack_id, rule_code, kind, applies_to, pattern,
              exempt_if_preceded_by, clause_key, rationale)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [packId, w.ruleCode, w.kind, w.appliesTo, w.pattern ?? null,
           w.exemptIfPrecededBy ?? null, w.clauseKey ?? null, w.rationale]);
      }

      await db.exec('commit');
      return {
        version: pack.version,
        contentHash,
        replacedExisting: replaced,
        counts: {
          genes: pack.genes.length,
          alleles: pack.alleles.length,
          drugs: pack.drugs.length,
          pairs: pack.pairs.length,
          phenotypes: pack.phenotypes.length,
          diplotypes: pack.diplotypes.length,
          recommendations: pack.recommendations.length,
          alternatives: pack.recommendations.reduce((n, r) => n + r.alternatives.length, 0),
          evidence: pack.evidence.length,
          wordingRules: pack.wordingRules.length,
        },
      };
    } catch (err) {
      try { await db.exec('rollback'); } catch { /* already unwound */ }
      throw err;
    }
  });
}
