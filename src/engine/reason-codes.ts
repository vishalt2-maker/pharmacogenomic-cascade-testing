/**
 * Every reason the engine can give. There is no "other".
 *
 * A reason code is a promise to the clinician standing in front of the
 * screen: the system will always be able to say exactly why it produced
 * nothing. Blocks are recorded, counted, and reported -- they are the most
 * valuable audit data the system generates and the best pilot metric
 * available, because they measure where the pathway actually breaks.
 */

export type Severity = 'block' | 'no_action' | 'inform' | 'warning';

export interface ReasonCodeDef {
  code: string;
  gate: string;
  severity: Severity;
  /** Shown to the user. Plain, specific, and never speculative. */
  message: string;
  /** What the user should do next, where anything can be done. */
  remedy?: string;
}

function def(
  code: string, gate: string, severity: Severity, message: string, remedy?: string,
): ReasonCodeDef {
  return { code, gate, severity, message, remedy };
}

export const REASON_CODES: readonly ReasonCodeDef[] = Object.freeze([
  // ---- G0 rule pack -------------------------------------------------
  def('RULE_PACK_MISSING', 'G0', 'block',
    'No rule pack was supplied to the safety engine.',
    'Load and activate a rule pack before evaluating any case.'),
  def('RULE_PACK_INACTIVE', 'G0', 'block',
    'The rule pack supplied is not the active pack.',
    'Activate exactly one rule pack.'),
  def('RULE_PACK_NOT_YET_EFFECTIVE', 'G0', 'block',
    'The rule pack is not yet effective.'),
  def('RULE_PACK_STALE', 'G0', 'block',
    'The rule pack has passed its expiry date.',
    'Import a current rule pack. Expiry is enforced because star-allele definitions and CPIC guidelines are revised.'),
  def('RULE_PACK_INVALID', 'G0', 'block',
    'The rule pack content hash does not match its recorded hash.',
    'The pack has been altered or corrupted. Re-import it from source.'),
  def('RULE_PACK_NOT_CLINICALLY_CURATED', 'G0', 'block',
    'The rule pack is marked as demonstration content and is not approved for clinical use.',
    'Import a curated pack whose citations have been checked against primary sources.'),
  def('RULE_PACK_EXPIRING_SOON', 'G0', 'warning',
    'The rule pack expires shortly.',
    'Schedule a refresh now, before it starts blocking.'),
  def('RULE_PACK_CITATIONS_UNVERIFIED', 'G0', 'warning',
    'One or more citations in this rule pack have not been checked against a primary source.'),

  // ---- G1 drug ------------------------------------------------------
  def('ADR_EVENT_MISSING', 'G1', 'block',
    'No adverse drug reaction event was supplied.'),
  def('ADR_DRUG_MISSING', 'G1', 'block',
    'The adverse drug reaction event does not name a suspect drug.'),
  def('DRUG_OUT_OF_SCOPE', 'G1', 'no_action',
    'The suspect drug is not part of a gene-drug pair in cascade scope.'),
  def('DRUG_AMBIGUOUS', 'G1', 'block',
    'The suspect drug name matched more than one drug in the rule pack.',
    'Record the drug using its International Nonproprietary Name.'),

  // ---- G2 reaction --------------------------------------------------
  def('REACTION_MISSING', 'G2', 'block',
    'The adverse drug reaction event does not record a reaction type.'),
  def('REACTION_OUT_OF_SCOPE', 'G2', 'no_action',
    'The reaction recorded is not a severe cutaneous adverse reaction in scope.'),

  // ---- G3 causality -------------------------------------------------
  def('CAUSALITY_NOT_ASSESSED', 'G3', 'block',
    'WHO-UMC causality has not been assessed for this event.',
    'Complete WHO-UMC causality assessment, as per PvPI practice, before proceeding.'),
  def('CAUSALITY_INSUFFICIENT', 'G3', 'block',
    'WHO-UMC causality is below the threshold of probable.',
    'Cascade testing starts from a confirmed index case. Possible or unlikely causality is not a confirmed index case.'),

  // ---- G4 consent ---------------------------------------------------
  def('CONSENT_MISSING', 'G4', 'block',
    'The index patient has not given active consent for every purpose this step requires.',
    'Record explicit, separate, witnessed consent in the patient’s own language.'),
  def('CONSENT_WITHDRAWN', 'G4', 'block',
    'Consent for a required purpose has been withdrawn.'),

  // ---- G5 genotype : THE GATE ---------------------------------------
  def('GENOTYPE_REQUIRED', 'G5', 'block',
    'No genotype result has been received for this index case.',
    'Order the test. Without a confirmed index genotype there is no family link, and nothing can cascade.'),
  def('LAB_NOT_ACCREDITED', 'G5', 'block',
    'The reporting laboratory does not hold an accepted accreditation.',
    'Accepted accreditations are configured per deployment, for example NABL or CAP.'),
  def('GENOTYPE_GENE_MISMATCH', 'G5', 'block',
    'The gene reported does not match the gene-drug pair under evaluation.'),
  def('GENOTYPE_RESULT_DATE_INVALID', 'G5', 'block',
    'The genotype result carries a result date in the future.',
    'A future-dated result is a data-entry error. Correct it at source.'),
  def('GENOTYPE_RESULT_EXPIRED', 'G5', 'block',
    'The genotype result is older than the configured maximum age.'),
  def('GENOTYPE_UNVERIFIED', 'G5', 'block',
    'The genotype result has been entered but not independently verified.',
    'A second registered user must verify the diplotype against the laboratory report. A transcription error in a genotype is a catastrophic failure mode.'),
  def('DIPLOTYPE_UNRECOGNISED', 'G5', 'block',
    'The diplotype reported cannot be resolved to a phenotype in this rule pack.',
    'An unrecognised diplotype is never treated as absence of risk. Check the laboratory report and the rule pack version.'),

  // ---- negative pathway ---------------------------------------------
  def('NEGATIVE_RESULT_NO_ADVISORY', 'G5', 'no_action',
    'The index genotype does not carry the risk allele, so no familial advisory is issued.',
    'The result is recorded in the registry. No document is produced, because a negative result does not establish absence of risk.'),
  def('NEGATIVE_DOES_NOT_EXCLUDE_RISK', 'G5', 'warning',
    'A negative result does not eliminate the risk of a severe cutaneous reaction. Clinical monitoring remains necessary.'),
  def('NEGATIVE_MONITORING_REMINDER', 'G5', 'inform',
    'A monitoring reminder may be issued. It must never be presented as reassurance.'),

  // ---- G6 recommendation --------------------------------------------
  def('RECOMMENDATION_MISSING', 'G6', 'block',
    'The rule pack holds no recommendation for this gene-drug pair and phenotype.'),
  def('RECOMMENDATION_AMBIGUOUS', 'G6', 'block',
    'The rule pack holds more than one recommendation for this gene-drug pair and phenotype.',
    'Ambiguity is never resolved by choosing the safer-sounding option. Correct the rule pack.'),
  def('ALTERNATIVE_CAUTION_MISSING', 'G6', 'block',
    'An alternative drug is flagged as carrying its own risk signal but no caution text is present.'),

  // ---- G7 actionability ---------------------------------------------
  def('BELOW_ACTIONABILITY_THRESHOLD', 'G7', 'inform',
    'The gene-drug pair is below the actionability threshold for issuing an advisory.',
    'Information may be displayed to the clinician. No familial advisory is produced.'),

  // ---- non-blocking notes -------------------------------------------
  def('UNTESTED_PAIRS_FOR_DRUG', 'G5', 'warning',
    'This drug has other gene-drug pairs in scope for which no genotype was supplied.'),
  def('INDIA_EVIDENCE_TIER_LOW', 'G7', 'warning',
    'The India Evidence Tier for this pair rests on limited or indirect Indian data.'),

  // ---- engine -------------------------------------------------------
  def('ENGINE_ERROR', 'G*', 'block',
    'The safety engine encountered an unexpected condition and stopped.',
    'The engine never degrades to a default. Report this with the evaluation identifier.'),
]);

const BY_CODE = new Map(REASON_CODES.map((r) => [r.code, r]));

export function reason(code: string): ReasonCodeDef {
  const r = BY_CODE.get(code);
  if (!r) {
    // An unknown reason code is itself a fail-closed condition: the system
    // must never emit a reason it cannot explain to a clinician.
    return {
      code, gate: 'G*', severity: 'block',
      message: `Unrecognised reason code ${code}.`,
    };
  }
  return r;
}

export function isBlocking(code: string): boolean {
  return reason(code).severity === 'block';
}

export const ALL_CODES: readonly string[] =
  Object.freeze(REASON_CODES.map((r) => r.code));
