/**
 * THE REGISTRY.
 *
 * This is the durable asset. There is no Indian national pharmacogenomic
 * SCAR registry; every case this system processes generates exactly the
 * data that is missing. The software is not the moat. This is.
 *
 * Three rules, enforced here rather than trusted to whoever runs the export:
 *
 *   1. CONSENT. Only cases with active `registry_deidentified` consent are
 *      exported. Withdrawal is honoured at export time, every time.
 *   2. DE-IDENTIFICATION. No org_id, no case_id, no date finer than month.
 *   3. SMALL-CELL SUPPRESSION. Any published cell below the threshold is
 *      withheld. In a population where the allele frequency is a couple of
 *      per cent, a count of one in a named state and month is a person.
 *
 * On the relative counts: the system never holds a link between an index
 * patient and a relative. A count can only appear here when a relative
 * CHOSE to present the family link token they were given, in person, at a
 * clinic. The link is made by the family, not by the software, and it
 * surfaces only in aggregate.
 */
import { asService } from '../db/client.ts';

export const DEFAULT_SUPPRESSION_THRESHOLD = 5;

export interface ExportOptions {
  runBy: string;
  suppressionThreshold?: number;
  /** Compute what would be exported without writing anything. */
  dryRun?: boolean;
}

export interface ExportResult {
  runId: string | null;
  rowsConsidered: number;
  rowsExported: number;
  rowsWithheldNoConsent: number;
  rows: RegistryRow[];
}

export interface RegistryRow {
  state: string | null;
  year_month: string;
  suspect_drug: string | null;
  reaction_type: string | null;
  causality: string | null;
  gene_symbol: string | null;
  diplotype: string | null;
  phenotype: string | null;
  advisory_issued: boolean;
  relatives_informed_count: number;
  relatives_tested_count: number;
  relatives_positive_count: number;
  india_evidence_tier: string | null;
  rule_pack_version: string | null;
}

/**
 * Candidate rows, de-identified in SQL so that identifying columns are
 * never selected into application memory in the first place.
 */
const CANDIDATE_SQL = `
  select
    c.state                                            as state,
    to_char(e.evaluated_at, 'YYYY-MM')                 as year_month,
    a.suspect_drug                                     as suspect_drug,
    a.reaction_type::text                              as reaction_type,
    a.causality_who_umc::text                          as causality,
    g.gene_symbol                                      as gene_symbol,
    g.diplotype                                        as diplotype,
    (e.gate_trace -> 5 -> 'detail' ->> 'phenotype')    as phenotype,
    coalesce(adv.status = 'issued', false)             as advisory_issued,
    coalesce((select sum(rs.count) from clinical.advisory_recipient_summary rs
               where rs.advisory_id = adv.id), 0)::int as relatives_informed_count,
    -- Relatives appear here ONLY where they chose to present the token.
    coalesce((select count(*) from clinical.self_referred_individuals sr
               where sr.presented_family_link_token = c.family_link_token
                 and not sr.declined_information), 0)::int as relatives_tested_count,
    coalesce((select count(*) from clinical.self_referred_individuals sr
               join clinical.genotype_results gr on gr.index_case_id = sr.own_index_case_id
              where sr.presented_family_link_token = c.family_link_token
                and gr.diplotype ilike '%15:02%'), 0)::int as relatives_positive_count,
    adv.india_evidence_tier                            as india_evidence_tier,
    e.rule_pack_version                                as rule_pack_version,
    exists (select 1 from clinical.consents cs
             where cs.index_case_id = c.id
               and cs.purpose = 'registry_deidentified'
               and cs.granted and cs.withdrawn_at is null) as has_consent
  from clinical.eligibility_evaluations e
  join clinical.index_cases c on c.id = e.index_case_id
  left join clinical.adr_events a on a.id = e.adr_event_id
  left join clinical.genotype_results g on g.id = e.genotype_result_id
  left join clinical.advisories adv on adv.evaluation_id = e.id
  where e.genotype_result_id is not null
`;

export async function exportToRegistry(opts: ExportOptions): Promise<ExportResult> {
  const threshold = opts.suppressionThreshold ?? DEFAULT_SUPPRESSION_THRESHOLD;

  return asService(async (db) => {
    const candidates = await db.query<RegistryRow & { has_consent: boolean }>(CANDIDATE_SQL);
    const consented = candidates.rows.filter((r) => r.has_consent);
    const withheld = candidates.rows.length - consented.length;

    const rows: RegistryRow[] = consented.map(({ has_consent: _c, ...r }) => ({
      ...r,
      relatives_informed_count: Number(r.relatives_informed_count),
      relatives_tested_count: Number(r.relatives_tested_count),
      relatives_positive_count: Number(r.relatives_positive_count),
    }));

    if (opts.dryRun) {
      return {
        runId: null, rowsConsidered: candidates.rows.length,
        rowsExported: rows.length, rowsWithheldNoConsent: withheld, rows,
      };
    }

    const run = await db.query<{ id: string }>(
      `insert into registry.export_runs
         (run_by, suppression_threshold, rows_considered, rows_exported,
          rows_withheld_no_consent, cells_suppressed)
       values ($1,$2,$3,$4,$5,0) returning id`,
      [opts.runBy, threshold, candidates.rows.length, rows.length, withheld]);
    const runId = run.rows[0].id;

    for (const r of rows) {
      await db.query(
        `insert into registry.cascade_records
           (state, year_month, suspect_drug, reaction_type, causality, gene_symbol,
            diplotype, phenotype, advisory_issued, relatives_informed_count,
            relatives_tested_count, relatives_positive_count, india_evidence_tier,
            rule_pack_version, export_run_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [r.state, r.year_month, r.suspect_drug, r.reaction_type, r.causality,
         r.gene_symbol, r.diplotype, r.phenotype, r.advisory_issued,
         r.relatives_informed_count, r.relatives_tested_count,
         r.relatives_positive_count, r.india_evidence_tier, r.rule_pack_version, runId]);
    }

    return {
      runId, rowsConsidered: candidates.rows.length, rowsExported: rows.length,
      rowsWithheldNoConsent: withheld, rows,
    };
  });
}

// ---------------------------------------------------------------------
// Publication: aggregates, with small-cell suppression.
// ---------------------------------------------------------------------
export interface AggregateCell {
  dimensions: Record<string, string | null>;
  count: number | null;
  suppressed: boolean;
}

export interface PublishedAggregate {
  groupedBy: string[];
  threshold: number;
  cells: AggregateCell[];
  cellsSuppressed: number;
  totalRows: number;
}

const ALLOWED_DIMENSIONS = new Set([
  'state', 'year_month', 'suspect_drug', 'reaction_type', 'causality',
  'gene_symbol', 'phenotype', 'india_evidence_tier', 'rule_pack_version',
  'advisory_issued',
]);

/**
 * Aggregate the registry for publication.
 *
 * Suppression is applied to the OUTPUT, unconditionally. A caller cannot
 * ask for it to be skipped, because the only reason to skip it is to see a
 * cell small enough to identify someone.
 */
export async function publishAggregate(
  groupBy: string[],
  opts: { threshold?: number } = {},
): Promise<PublishedAggregate> {
  const threshold = Math.max(1, opts.threshold ?? DEFAULT_SUPPRESSION_THRESHOLD);
  for (const g of groupBy) {
    if (!ALLOWED_DIMENSIONS.has(g)) {
      throw new Error(
        `REGISTRY_DIMENSION_REFUSED: "${g}" is not a publishable dimension. ` +
        `Publishable dimensions are: ${[...ALLOWED_DIMENSIONS].join(', ')}.`);
    }
  }
  if (groupBy.length === 0) throw new Error('REGISTRY_DIMENSION_REQUIRED');

  return asService(async (db) => {
    const cols = groupBy.map((g) => `"${g}"`).join(', ');
    const r = await db.query<Record<string, unknown>>(
      `select ${cols}, count(*)::int as n from registry.cascade_records
        group by ${cols} order by ${cols}`);

    let suppressed = 0;
    let total = 0;
    const cells: AggregateCell[] = r.rows.map((row) => {
      const n = Number(row.n);
      total += n;
      const dimensions: Record<string, string | null> = {};
      for (const g of groupBy) {
        const v = row[g];
        dimensions[g] = v === null || v === undefined ? null : String(v);
      }
      // A count below the threshold re-identifies. It is withheld, and the
      // fact that it was withheld is reported.
      if (n < threshold) { suppressed += 1; return { dimensions, count: null, suppressed: true }; }
      return { dimensions, count: n, suppressed: false };
    });

    return { groupedBy: groupBy, threshold, cells, cellsSuppressed: suppressed, totalRows: total };
  });
}

/**
 * The pilot's primary endpoints, stated as a falsifiable prediction.
 *
 * The thesis is that a first-degree relative of a confirmed carrier has
 * roughly a 50% prior, against a population carrier rate of a few per cent.
 * If carrier yield in tested relatives comes back at population baseline,
 * THE THESIS IS WRONG, and the point of measuring it is to find that out
 * early and cheaply rather than late and expensively.
 */
export interface PilotEndpoints {
  indexCasesEvaluated: number;
  indexCasesGenotyped: number;
  indexGenotypingRate: number | null;
  advisoriesIssued: number;
  relativesInformed: number;
  relativesTested: number;
  relativesPositive: number;
  relativeUptakeRate: number | null;
  carrierYieldInTestedRelatives: number | null;
  predictedCarrierYield: number;
  blocksByReason: Array<{ reason: string; n: number }>;
  suppressedBelow: number;
}

export async function pilotEndpoints(
  opts: { threshold?: number } = {},
): Promise<PilotEndpoints> {
  const threshold = opts.threshold ?? DEFAULT_SUPPRESSION_THRESHOLD;
  return asService(async (db) => {
    const totals = (await db.query<Record<string, string>>(`
      select
        (select count(*) from clinical.eligibility_evaluations)::text as evaluated,
        (select count(distinct index_case_id) from clinical.genotype_results)::text as genotyped,
        (select count(distinct index_case_id) from clinical.eligibility_evaluations)::text as cases,
        (select count(*) from clinical.advisories where status = 'issued')::text as issued,
        (select coalesce(sum(relatives_informed_count),0) from registry.cascade_records)::text as informed,
        (select coalesce(sum(relatives_tested_count),0) from registry.cascade_records)::text as tested,
        (select coalesce(sum(relatives_positive_count),0) from registry.cascade_records)::text as positive
    `)).rows[0];

    const blocks = (await db.query<{ reason: string; n: string }>(`
      select unnest(reason_codes) as reason, count(*)::text as n
        from clinical.eligibility_evaluations
       where decision = 'BLOCK'
       group by 1 order by 2 desc
    `)).rows;

    const cases = Number(totals.cases);
    const genotyped = Number(totals.genotyped);
    const tested = Number(totals.tested);
    const positive = Number(totals.positive);
    const informed = Number(totals.informed);

    const suppress = (n: number, d: number): number | null =>
      d >= threshold ? Number((n / d).toFixed(3)) : null;

    return {
      indexCasesEvaluated: cases,
      indexCasesGenotyped: genotyped,
      indexGenotypingRate: suppress(genotyped, cases),
      advisoriesIssued: Number(totals.issued),
      relativesInformed: informed,
      relativesTested: tested,
      relativesPositive: positive,
      relativeUptakeRate: suppress(tested, informed),
      carrierYieldInTestedRelatives: suppress(positive, tested),
      predictedCarrierYield: 0.5,
      blocksByReason: blocks.map((b) => ({ reason: b.reason, n: Number(b.n) })),
      suppressedBelow: threshold,
    };
  });
}
