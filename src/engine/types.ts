/** Shared types for the knowledge layer and the safety engine. */

export type ProvenanceStatus =
  | 'demonstration' | 'curated_unverified' | 'curated_verified';
export type EvidenceStrength = 'high' | 'moderate' | 'weak';
export type CpicActionability = 'A' | 'B' | 'C' | 'D' | 'A/B' | 'B/C' | 'C/D';
export type RecStrength = 'strong' | 'moderate' | 'optional' | 'no recommendation';
export type IndiaTier = 'IN-1' | 'IN-2' | 'IN-3' | 'IN-4' | 'IN-0';
export type ActionCode =
  | 'avoid_drug' | 'reduce_dose' | 'standard_dose'
  | 'use_with_caution' | 'no_recommendation' | 'monitor_only';
export type VerificationStatus =
  | 'verified_primary_source' | 'unverified' | 'disputed';

export type WhoUmc =
  | 'certain' | 'probable' | 'possible' | 'unlikely'
  | 'conditional' | 'unassessable' | 'not_assessed';

export type ReactionType =
  | 'SJS' | 'TEN' | 'SJS_TEN_overlap' | 'DRESS' | 'MPE'
  | 'AGEP' | 'other_cutaneous' | 'non_cutaneous';

/**
 * The India Evidence Tier. CPIC's grading is global; India's evidence base
 * for these alleles is thin, geographically skewed and built on small case
 * series. Applying a global grade to an Indian patient without saying so is
 * a quiet overclaim, so the tier is printed on every advisory.
 */
export const INDIA_TIER_DEFINITIONS: Record<IndiaTier, string> = Object.freeze({
  'IN-1': 'Adequately powered Indian association study or meta-analysis with Indian cohorts.',
  'IN-2': 'Small Indian case series or case-control data (fewer than 50 cases).',
  'IN-3': 'South Asian or diaspora data only, for example Malaysian Indian cohorts.',
  'IN-4': 'Extrapolated from non-Indian populations. No direct Indian evidence.',
  'IN-0': 'Indian data actively conflicting, or absent.',
});

export interface Gene { symbol: string; name?: string; clinpgxId?: string; hgncId?: string; }

export interface Allele {
  geneSymbol: string;
  alleleName: string;
  clinicalFunction: string;
  /** DIMENSION 4: allele function assignment strength, graded separately. */
  functionEvidence?: EvidenceStrength;
  pharmvarId?: string;
}

export interface Drug {
  name: string;
  rxnormId?: string;
  atcCode?: string;
  clinpgxId?: string;
  isAromaticAnticonvulsant?: boolean;
  synonyms?: string[];
}

export interface GeneDrugPair {
  id: string;
  geneSymbol: string;
  drugName: string;
  /** DIMENSION 1: actionability. NOT a level of evidence. */
  cpicActionability: CpicActionability;
  /** DIMENSION 3: strength of evidence for the findings. */
  evidenceStrength?: EvidenceStrength;
  /** DIMENSION 5: our addition. */
  indiaEvidenceTier: IndiaTier;
  indiaTierRationale?: string;
  guidelineCitation: string;
  guidelineVersion: string;
  guidelinePmid?: string;
  guidelineDoi?: string;
  guidelineUrl?: string;
  /** What a negative result means for THIS pair. CPIC is not uniform here. */
  negativeResultCaution: string;
  inCascadeScope: boolean;
  evidenceIds?: string[];
}

export interface Phenotype {
  id: string;
  geneSymbol: string;
  term: string;
  description?: string;
  /**
   * Whether this phenotype is the risk phenotype for the pair. Structural,
   * so the negative pathway is never decided by string-matching the word
   * "negative" at render time.
   */
  isRiskPhenotype: boolean;
}

export interface DiplotypeMapping {
  geneSymbol: string;
  diplotype: string;
  phenotypeId: string;
  activityScore?: number;
}

export interface Alternative {
  drugName: string;
  cautionFlag: boolean;
  cautionText?: string;
}

export interface Recommendation {
  id: string;
  pairId: string;
  phenotypeId: string;
  actionCode: ActionCode;
  /** DIMENSION 2: how firmly the action is advised. */
  recommendationStrength: RecStrength;
  clinicalText: string;
  implicationsText?: string;
  sourceTableRef?: string;
  alternatives: Alternative[];
}

export interface EvidenceSource {
  id: string;
  citation: string;
  pmid?: string;
  doi?: string;
  studyDesign?: string;
  population?: string;
  country?: string;
  caseN?: number;
  controlN?: number;
  effectMeasure?: string;
  effectValue?: number;
  ciLow?: number;
  ciHigh?: number;
  isIndianCohort?: boolean;
  verificationStatus: VerificationStatus;
  verifiedUrl?: string;
  quality_notes?: string;
}

export interface PopulationFrequency {
  alleleName: string;
  geneSymbol: string;
  population: string;
  region?: string;
  alleleFreq?: number;
  carrierFreq?: number;
  sampleN?: number;
  sourceId?: string;
}

export interface WordingRule {
  ruleCode: string;
  kind: 'banned' | 'mandatory';
  appliesTo: 'clinical' | 'patient' | 'both';
  pattern?: string;
  /** Regex for preceding context that exempts a match, e.g. a negation. */
  exemptIfPrecededBy?: string;
  clauseKey?: string;
  rationale: string;
}

export interface RulePack {
  version: string;
  cpicRelease?: string;
  sourceUrl?: string;
  publishedAt: string;
  effectiveFrom: string;
  expiresAt: string;
  contentHash: string;
  signature?: string;
  isActive: boolean;
  provenanceStatus: ProvenanceStatus;
  curatedBy?: string;
  notes?: string;
  genes: Gene[];
  alleles: Allele[];
  drugs: Drug[];
  pairs: GeneDrugPair[];
  phenotypes: Phenotype[];
  diplotypes: DiplotypeMapping[];
  recommendations: Recommendation[];
  evidence: EvidenceSource[];
  populationFrequencies: PopulationFrequency[];
  wordingRules: WordingRule[];
}

// ---------------------------------------------------------------------
// Engine input and output
// ---------------------------------------------------------------------

export interface AdrEventInput {
  suspectDrug: string | null;
  reactionType: ReactionType | null;
  causalityWhoUmc: WhoUmc | null;
  onsetDate?: string | null;
  latencyDays?: number | null;
  vigiflowRef?: string | null;
}

export interface GenotypeResultInput {
  geneSymbol: string | null;
  diplotype: string | null;
  method: string | null;
  labName: string | null;
  labAccreditation: string | null;
  reportRef: string | null;
  resultedAt: string | null;
  verified: boolean;
}

export interface ConsentState {
  genotyping: boolean;
  advisory_issue: boolean;
  counselling?: boolean;
  registry_deidentified?: boolean;
  recontact?: boolean;
}

export interface EnginePolicy {
  acceptedAccreditations: string[];
  /** Null means germline results do not expire. See docs/CORRECTIONS.md. */
  genotypeMaxAgeDays: number | null;
  inScopeReactions: ReactionType[];
  sufficientCausality: WhoUmc[];
  requireIndependentVerification: boolean;
  /** v1 default is 'none': issue nothing on a negative result. */
  negativePathway: 'none' | 'monitoring_reminder';
  allowDemonstrationPack: boolean;
  requireCascadeScope: boolean;
  rulePackWarnWindowDays: number;
  /** Only these actionability levels may produce an advisory. */
  actionableLevels: CpicActionability[];
}

export const DEFAULT_POLICY: EnginePolicy = Object.freeze({
  acceptedAccreditations: ['NABL', 'CAP'],
  genotypeMaxAgeDays: null,
  inScopeReactions: ['SJS', 'TEN', 'SJS_TEN_overlap', 'DRESS', 'MPE'],
  sufficientCausality: ['probable', 'certain'],
  requireIndependentVerification: true,
  negativePathway: 'none',
  allowDemonstrationPack: false,
  requireCascadeScope: true,
  rulePackWarnWindowDays: 30,
  actionableLevels: ['A', 'B'],
});

export interface EvaluationInput {
  now: Date;
  rulePack: RulePack | null;
  adrEvent: AdrEventInput | null;
  consents: ConsentState;
  genotypeResult: GenotypeResultInput | null;
  policy?: Partial<EnginePolicy>;
}

export type EngineDecision =
  'ADVISORY_DRAFT' | 'INFORM_ONLY' | 'NO_ACTION' | 'BLOCK';

export interface GateTraceEntry {
  gate: string;
  name: string;
  status: 'pass' | 'fail' | 'skipped';
  reasonCodes: string[];
  detail: Record<string, unknown>;
}

/** What the engine resolved, when it got far enough to resolve anything. */
export interface ResolvedFinding {
  pair: GeneDrugPair;
  phenotype: Phenotype;
  diplotype: string;
  recommendation: Recommendation;
  alternatives: Alternative[];
  evidence: EvidenceSource[];
  populationFrequencies: PopulationFrequency[];
  indiaEvidenceTier: IndiaTier;
  indiaTierDefinition: string;
}

export interface EvaluationResult {
  decision: EngineDecision;
  reasonCodes: string[];
  warnings: string[];
  rulePackVersion: string | null;
  indiaEvidenceTier: IndiaTier | null;
  engineVersion: string;
  gateTrace: GateTraceEntry[];
  finding: ResolvedFinding | null;
  /** True when the index genotype does not carry the risk allele. */
  negativePathway: boolean;
  evaluatedAt: string;
}
