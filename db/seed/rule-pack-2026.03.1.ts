/**
 * RULE PACK 2026.03.1 -- hand-curated, deliberately tiny.
 *
 * One gene. Two drugs. HLA-B*15:02 with carbamazepine and phenytoin.
 * CPIC publishes guidance on hundreds of gene-drug pairs; loading all of
 * them would multiply the surface to be curated, verified and defended
 * without adding a single case to the cascade this system exists to run.
 *
 * PROVENANCE: this pack is marked 'demonstration'. The safety engine
 * refuses to issue from a demonstration pack unless a deployment explicitly
 * opts in, and the renderer prints a banner on every page. Promotion to
 * 'curated_verified' requires a human to open every cited source, which is
 * tracked per-source in `verificationStatus`.
 *
 * Recommendation text is PARAPHRASED, never copied from CPIC. The licence
 * for redistributing CPIC / ClinPGx / PharmVar content in a product must be
 * confirmed in writing before shipping. See docs/GOVERNANCE.md.
 */
import type { RulePack } from '../../src/engine/types.ts';
import { WORDING_RULES } from './wording-rules.ts';

const CBZ_GUIDELINE =
  'Phillips EJ, Sukasem C, Whirl-Carrillo M, et al. Clinical Pharmacogenetics Implementation Consortium Guideline for HLA Genotype and Use of Carbamazepine and Oxcarbazepine: 2017 Update. Clin Pharmacol Ther. 2018 Apr;103(4):574-581.';
const PHT_GUIDELINE =
  'Karnes JH, Rettie AE, Somogyi AA, et al. Clinical Pharmacogenetics Implementation Consortium (CPIC) Guideline for CYP2C9 and HLA-B Genotypes and Phenytoin Dosing: 2020 Update. Clin Pharmacol Ther. 2021 Feb;109(2):302-309.';

export const RULE_PACK: RulePack = {
  version: '2026.03.1',
  cpicRelease: 'see sourceUrl; pin the exact upstream release before clinical use',
  sourceUrl: 'https://cpicpgx.org/',
  publishedAt: '2026-09-01T00:00:00.000Z',
  effectiveFrom: '2026-09-01T00:00:00.000Z',
  // 180-day expiry, with the engine warning from day 150. Star-allele
  // definitions are dynamic and CPIC guidelines are revised; a cached
  // ruleset that never expires is a patient-safety defect waiting to happen.
  expiresAt: '2027-02-28T00:00:00.000Z',
  contentHash: '',            // stamped by db/seed/build.ts
  isActive: true,
  provenanceStatus: 'demonstration',
  curatedBy: 'PCT concept build',
  notes:
    'Demonstration content for a concept build. Nothing here is deployed, has been validated, or carries regulatory approval of any kind. Citations were checked against primary bibliographic records during the build; that is not the same as a human curator having read each paper. See docs/VERIFICATION.md.',

  genes: [
    {
      symbol: 'HLA-B',
      name: 'Major histocompatibility complex, class I, B',
      // CPIC renamed gene.pharmgkbid to gene.clinpgxid in the March 2026
      // release. Logically identical; the new name is used throughout.
      clinpgxId: 'PA35056',
      hgncId: 'HGNC:4932',
    },
  ],

  alleles: [
    {
      geneSymbol: 'HLA-B', alleleName: '*15:02',
      clinicalFunction: 'risk allele',
      // DIMENSION 4, graded separately from the pair's evidence.
      functionEvidence: 'high',
    },
    {
      geneSymbol: 'HLA-B', alleleName: 'other',
      clinicalFunction: 'non-risk allele',
      functionEvidence: 'high',
    },
  ],

  drugs: [
    {
      name: 'carbamazepine', atcCode: 'N03AF01', isAromaticAnticonvulsant: true,
      synonyms: ['CBZ', 'Tegretol', 'carbamazepin', 'Mazetol', 'Zeptol'],
    },
    {
      name: 'phenytoin', atcCode: 'N03AB02', isAromaticAnticonvulsant: true,
      synonyms: ['PHT', 'Dilantin', 'Eptoin', 'diphenylhydantoin', 'fosphenytoin'],
    },
    {
      name: 'oxcarbazepine', atcCode: 'N03AF02', isAromaticAnticonvulsant: true,
      synonyms: ['OXC', 'Trileptal', 'Oxetol'],
    },
    {
      name: 'eslicarbazepine acetate', atcCode: 'N03AF04', isAromaticAnticonvulsant: true,
      synonyms: ['eslicarbazepine', 'Aptiom', 'Zebinix'],
    },
    {
      name: 'lamotrigine', atcCode: 'N03AX09', isAromaticAnticonvulsant: true,
      synonyms: ['LTG', 'Lamictal', 'Lamitor'],
    },
    { name: 'valproic acid', atcCode: 'N03AG01', synonyms: ['sodium valproate', 'valproate', 'Valparin', 'Encorate'] },
    { name: 'levetiracetam', atcCode: 'N03AX14', synonyms: ['LEV', 'Keppra', 'Levipil'] },
  ],

  pairs: [
    {
      id: 'pair-hlab-cbz',
      geneSymbol: 'HLA-B', drugName: 'carbamazepine',
      cpicActionability: 'A',        // DIMENSION 1: actionability, NOT evidence
      evidenceStrength: 'high',      // DIMENSION 3: evidence for the findings
      indiaEvidenceTier: 'IN-2',     // DIMENSION 5: ours
      indiaTierRationale:
        'Real association with a strong effect, but Indian data rest on small case series and case-control studies sampled largely from North Indian cohorts, and are not representative of a country with this much population structure. The single direct Indian association study in this pack genotyped eight carbamazepine-SJS patients.',
      guidelineCitation: CBZ_GUIDELINE,
      guidelineVersion: '2017 update',
      guidelinePmid: '29392710',
      guidelineDoi: '10.1002/cpt.1004',
      guidelineUrl: 'https://www.clinpgx.org/guideline/PA166251448',
      /**
       * CPIC'S POSITION ON A NEGATIVE RESULT IS NOT THE SAME FOR BOTH DRUGS
       * IN THIS PACK, which is why this text lives on the pair.
       *
       * For carbamazepine the 2017 guideline assigns HLA-B*15:02-negative
       * patients normal risk of carbamazepine-induced SJS/TEN. What it does
       * NOT support is treating that negative as protection against other
       * aromatic anticonvulsants -- the guideline warns specifically that
       * switching on the strength of a negative HLA-B*15:02 will not prevent
       * anticonvulsant-associated SJS/TEN.
       */
      negativeResultCaution:
        'A negative HLA-B*15:02 result does not protect against severe cutaneous reactions to other aromatic anticonvulsants, and does not address risk alleles or non-genetic risk factors outside the scope of this test. Clinical monitoring remains necessary.',
      inCascadeScope: true,
      evidenceIds: ['ev-cpic-cbz', 'ev-mehta-2009', 'ev-freq-india', 'ev-cost-hk'],
    },
    {
      id: 'pair-hlab-pht',
      geneSymbol: 'HLA-B', drugName: 'phenytoin',
      cpicActionability: 'A',
      evidenceStrength: 'moderate',
      indiaEvidenceTier: 'IN-2',
      indiaTierRationale:
        'Indian evidence for the phenytoin association is thinner than for carbamazepine and rests on small series and pooled South Asian analyses.',
      guidelineCitation: PHT_GUIDELINE,
      guidelineVersion: '2020 update',
      guidelinePmid: '32779747',
      guidelineDoi: '10.1002/cpt.2008',
      guidelineUrl: 'https://www.clinpgx.org/guideline/PA166122806',
      /**
       * For phenytoin, by contrast, CPIC states directly that a negative
       * test does not eliminate the risk of phenytoin-induced SJS/TEN and
       * that patients should be carefully monitored.
       */
      negativeResultCaution:
        'A negative HLA-B*15:02 result does not eliminate the risk of phenytoin-induced severe cutaneous reactions. Clinical monitoring remains necessary. CYP2C9 genotype is a separate consideration addressed by the same published guideline and is not covered here.',
      inCascadeScope: true,
      evidenceIds: ['ev-cpic-pht', 'ev-freq-india'],
    },
  ],

  phenotypes: [
    {
      id: 'ph-hlab-pos', geneSymbol: 'HLA-B', term: 'HLA-B*15:02 positive',
      description: 'At least one copy of HLA-B*15:02 present.',
      isRiskPhenotype: true,
    },
    {
      id: 'ph-hlab-neg', geneSymbol: 'HLA-B', term: 'HLA-B*15:02 negative',
      description:
        'No copy of HLA-B*15:02 detected by the method used. This is not an absence of risk.',
      isRiskPhenotype: false,
    },
  ],

  /**
   * Every diplotype a laboratory can report, mapped explicitly.
   *
   * Indian laboratories running targeted PCR-SSP commonly report
   * "Positive" or "Negative" rather than a full two-field diplotype, so
   * both reporting conventions are enumerated. Anything NOT in this list is
   * UNRECOGNISED and blocks. An unrecognised diplotype is never quietly
   * treated as absence of risk.
   */
  diplotypes: [
    // --- carrier, targeted reporting convention
    { geneSymbol: 'HLA-B', diplotype: 'positive', phenotypeId: 'ph-hlab-pos' },
    { geneSymbol: 'HLA-B', diplotype: '*15:02 positive', phenotypeId: 'ph-hlab-pos' },
    { geneSymbol: 'HLA-B', diplotype: '*15:02/X', phenotypeId: 'ph-hlab-pos' },
    // --- carrier, two-field reporting
    { geneSymbol: 'HLA-B', diplotype: '*15:02/*15:02', phenotypeId: 'ph-hlab-pos' },
    { geneSymbol: 'HLA-B', diplotype: '*15:02/*40:06', phenotypeId: 'ph-hlab-pos' },
    { geneSymbol: 'HLA-B', diplotype: '*15:02/*44:03', phenotypeId: 'ph-hlab-pos' },
    { geneSymbol: 'HLA-B', diplotype: '*15:02/*51:01', phenotypeId: 'ph-hlab-pos' },
    { geneSymbol: 'HLA-B', diplotype: '*15:02/*07:05', phenotypeId: 'ph-hlab-pos' },
    { geneSymbol: 'HLA-B', diplotype: '*15:02/*35:03', phenotypeId: 'ph-hlab-pos' },
    { geneSymbol: 'HLA-B', diplotype: '*15:02/*52:01', phenotypeId: 'ph-hlab-pos' },
    // --- non-carrier
    { geneSymbol: 'HLA-B', diplotype: 'negative', phenotypeId: 'ph-hlab-neg' },
    { geneSymbol: 'HLA-B', diplotype: '*15:02 negative', phenotypeId: 'ph-hlab-neg' },
    { geneSymbol: 'HLA-B', diplotype: 'X/X', phenotypeId: 'ph-hlab-neg' },
    { geneSymbol: 'HLA-B', diplotype: '*40:06/*44:03', phenotypeId: 'ph-hlab-neg' },
    { geneSymbol: 'HLA-B', diplotype: '*51:01/*52:01', phenotypeId: 'ph-hlab-neg' },
    { geneSymbol: 'HLA-B', diplotype: '*07:05/*35:03', phenotypeId: 'ph-hlab-neg' },
  ],

  recommendations: [
    {
      id: 'rec-cbz-pos',
      pairId: 'pair-hlab-cbz', phenotypeId: 'ph-hlab-pos',
      actionCode: 'avoid_drug',
      recommendationStrength: 'strong',   // DIMENSION 2
      clinicalText:
        'Published guidance for an HLA-B*15:02 positive individual who is carbamazepine-naive is to use an antiseizure medication other than carbamazepine. The recommendation applies regardless of CYP2C9 genotype, ancestry or age. Where carbamazepine has already been taken for more than approximately three months without a cutaneous reaction, published guidance describes the ongoing risk as extremely low, though not zero; this document concerns future prescribing.',
      implicationsText:
        'HLA-B*15:02 is associated with a markedly increased risk of carbamazepine-induced Stevens-Johnson Syndrome and Toxic Epidermal Necrolysis. The guideline cited here reports mortality typically below 5% for Stevens-Johnson Syndrome and above 30% for Toxic Epidermal Necrolysis, with sepsis the most frequent cause of death. Survivors frequently carry permanent ocular damage and scarring.',
      sourceTableRef: 'CPIC 2017 update, recommendation table for carbamazepine',
      alternatives: [
        {
          /**
           * Oxcarbazepine is NOT merely "an alternative with a caution".
           * CPIC extended the HLA-B*15:02 recommendation to it, and pairs it
           * with HLA-B at Level A in its own right.
           */
          drugName: 'oxcarbazepine', cautionFlag: true,
          cautionText:
            'Published guidance extends the same avoidance recommendation to oxcarbazepine in HLA-B*15:02 positive individuals. The positive predictive value of HLA-B*15:02 differs between the two drugs: the guideline reports 0.73% for oxcarbazepine-induced Stevens-Johnson Syndrome or Toxic Epidermal Necrolysis against 7.7% for carbamazepine. This is not an appropriate substitute in a carrier.',
        },
        {
          /**
           * CORRECTED against the primary source. An earlier draft of this
           * pack asserted that eslicarbazepine "carries its own signal in
           * HLA-B*15:02 carriers". CPIC does not say that. It says the
           * evidence is very limited, if any, and that caution applies when
           * choosing an alternative. There is no HLA-B pair for
           * eslicarbazepine at any CPIC level. Overstating a signal is the
           * same class of error as understating one.
           */
          drugName: 'eslicarbazepine acetate', cautionFlag: true,
          cautionText:
            'Published guidance describes very limited evidence, if any, linking severe cutaneous reactions with HLA-B*15:02 for this drug, and advises caution when choosing an alternative. It is structurally related to carbamazepine and oxcarbazepine. No formal genotype-based recommendation is made for it.',
        },
        {
          drugName: 'lamotrigine', cautionFlag: true,
          cautionText:
            'Published guidance describes very limited evidence, if any, linking severe cutaneous reactions with HLA-B*15:02 for lamotrigine, and advises caution when choosing an alternative. Lamotrigine separately carries a titration-dependent rash risk that is independent of genotype.',
        },
        {
          drugName: 'phenytoin', cautionFlag: true,
          cautionText:
            'Phenytoin carries its own HLA-B*15:02 association at the same actionability level and is addressed by a separate published guideline. It is not a substitute for carbamazepine in a carrier.',
        },
        { drugName: 'valproic acid', cautionFlag: false },
        { drugName: 'levetiracetam', cautionFlag: false },
      ],
    },
    {
      id: 'rec-cbz-neg',
      pairId: 'pair-hlab-cbz', phenotypeId: 'ph-hlab-neg',
      actionCode: 'monitor_only',
      recommendationStrength: 'optional',
      clinicalText:
        'No HLA-B*15:02-based contraindication to carbamazepine is raised by this result. Published guidance assigns HLA-B*15:02-negative individuals normal risk of carbamazepine-induced Stevens-Johnson Syndrome or Toxic Epidermal Necrolysis. That finding is specific to carbamazepine and oxcarbazepine: the same guidance warns that switching to another aromatic anticonvulsant on the strength of a negative HLA-B*15:02 result will not prevent anticonvulsant-associated severe cutaneous reactions.',
      implicationsText:
        'This system issues no familial advisory on a negative index result. The result is recorded for the registry, where negative index cases are as informative as positive ones.',
      alternatives: [],
    },
    {
      id: 'rec-pht-pos',
      pairId: 'pair-hlab-pht', phenotypeId: 'ph-hlab-pos',
      actionCode: 'avoid_drug',
      recommendationStrength: 'strong',
      clinicalText:
        'Published guidance for an HLA-B*15:02 positive individual who is phenytoin-naive is to avoid phenytoin and fosphenytoin, and to use an alternative antiseizure medication. Carbamazepine and oxcarbazepine are not appropriate alternatives, because they carry the same association at the same actionability level.',
      implicationsText:
        'HLA-B*15:02 is associated with an increased risk of phenytoin-induced Stevens-Johnson Syndrome and Toxic Epidermal Necrolysis. CYP2C9 genotype is addressed separately within the same published guideline and is outside the scope of this advisory.',
      sourceTableRef: 'CPIC 2020 update, recommendation table for phenytoin',
      alternatives: [
        {
          drugName: 'carbamazepine', cautionFlag: true,
          cautionText: 'Carries the same HLA-B*15:02 association at the same actionability level. Not an appropriate alternative in a carrier.',
        },
        {
          drugName: 'oxcarbazepine', cautionFlag: true,
          cautionText: 'Published guidance extends the avoidance recommendation for HLA-B*15:02 positive individuals to oxcarbazepine. Not an appropriate alternative in a carrier.',
        },
        {
          drugName: 'lamotrigine', cautionFlag: true,
          cautionText: 'Published guidance describes weaker evidence for this drug and advises caution when choosing an alternative. A titration-dependent rash risk applies independently of genotype.',
        },
        { drugName: 'valproic acid', cautionFlag: false },
        { drugName: 'levetiracetam', cautionFlag: false },
      ],
    },
    {
      id: 'rec-pht-neg',
      pairId: 'pair-hlab-pht', phenotypeId: 'ph-hlab-neg',
      actionCode: 'monitor_only',
      recommendationStrength: 'optional',
      clinicalText:
        'No HLA-B*15:02-based contraindication to phenytoin is raised by this result. Published guidance states directly that a negative HLA-B*15:02 test does not eliminate the risk of phenytoin-induced Stevens-Johnson Syndrome or Toxic Epidermal Necrolysis, and that patients should be carefully monitored according to standard practice. CYP2C9 genotype is a separate consideration and is not addressed here.',
      alternatives: [],
    },
  ],

  /**
   * EVIDENCE. Every claim traceable to a paper.
   *
   * `verificationStatus` is not decoration. "Do not cite anything you have
   * not personally opened" is worth nothing unless the database can express
   * whether someone did.
   *
   * VERIFICATION PROVENANCE: the records marked verified here were checked
   * against the NCBI E-utilities MEDLINE records and the publishers' own
   * pages during this build. That is a machine verification against a
   * primary record, which is a real step above transcription, and is still
   * NOT a human curator having read the paper. The pack therefore stays at
   * provenance status 'demonstration'. See docs/VERIFICATION.md.
   */
  evidence: [
    {
      id: 'ev-cpic-cbz',
      citation: CBZ_GUIDELINE,
      pmid: '29392710',
      doi: '10.1002/cpt.1004',
      studyDesign: 'clinical practice guideline',
      population: 'international', country: 'multinational',
      verificationStatus: 'verified_primary_source',
      verifiedUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5847474/',
      quality_notes:
        'Primary source for the carbamazepine recommendation. Note the exact title: HLA Genotype and USE OF carbamazepine and oxcarbazepine. Its gene scope is deliberately broader than HLA-B and includes HLA-A*31:01, which this pack does not cover.',
    },
    {
      id: 'ev-cpic-pht',
      citation: PHT_GUIDELINE,
      pmid: '32779747',
      doi: '10.1002/cpt.2008',
      studyDesign: 'clinical practice guideline',
      population: 'international', country: 'multinational',
      verificationStatus: 'verified_primary_source',
      verifiedUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7831382/',
      quality_notes:
        'Primary source for the phenytoin recommendation. Covers CYP2C9 as well as HLA-B; only the HLA-B component is in scope here. This guideline, unlike the carbamazepine one, states directly that a negative result does not eliminate risk.',
    },
    {
      id: 'ev-mehta-2009',
      citation:
        'Mehta TY, Prajapati LM, Mittal B, et al. Association of HLA-B*1502 allele and carbamazepine-induced Stevens-Johnson syndrome among Indians. Indian J Dermatol Venereol Leprol. 2009 Nov-Dec;75(6):579-582.',
      pmid: '19915237',
      doi: '10.4103/0378-6323.57718',
      studyDesign: 'case-control',
      population: 'Indian', country: 'India',
      caseN: 8,
      isIndianCohort: true,
      verificationStatus: 'verified_primary_source',
      verifiedUrl: 'https://ijdvl.com/association-of-hla-b1502-allele-and-carbamazepine-induced-stevens-johnson-syndrome-among-indians/',
      quality_notes:
        'Eight carbamazepine-SJS patients were genotyped and six carried HLA-B*1502. This is one of the few direct Indian association studies, and its size is the principal reason this pair sits at IN-2 rather than IN-1. Control-group counts and the reported odds ratio were NOT confirmed verbatim during this build and are deliberately not recorded here.',
    },
    {
      id: 'ev-freq-india',
      citation:
        'Biswas M, Murad MA, Ershadian M, Sukasem C. Investigation of the Prevalence of the HLA-B*15:02 Allele in the Asian Populations: A Comprehensive Analysis Through Using AFND. Health Sci Rep. 2026 Aug;9(8):e72903.',
      pmid: '42524381',
      doi: '10.1002/hsr2.72903',
      studyDesign: 'population frequency analysis',
      population: 'Indian', country: 'India',
      caseN: 714,
      isIndianCohort: true,
      verificationStatus: 'verified_primary_source',
      verifiedUrl: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC13411286/',
      quality_notes:
        'Weighted mean HLA-B*15:02 allele frequency for India of 2.1% (SD 1.5), from n=714 individuals in the Allele Frequency Net Database. The range across Indian sub-populations runs from 0% to 14.2%. TREAT WITH CAUTION: 714 individuals is a very thin basis for a country of this size and genetic diversity, and the per-community breakdown was not retrieved. Nothing in this system computes risk from this figure.',
    },
    {
      id: 'ev-cost-hk',
      citation:
        'Chen Z, Liew D, Kwan P. Real-world efficiency of pharmacogenetic screening for carbamazepine-induced severe cutaneous adverse reactions. PLoS One. 2014;9(5):e96990.',
      pmid: '24806465',
      doi: '10.1371/journal.pone.0096990',
      studyDesign: 'real-world screening efficiency analysis',
      population: 'Hong Kong Chinese', country: 'Hong Kong',
      verificationStatus: 'verified_primary_source',
      verifiedUrl: 'https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0096990',
      quality_notes:
        'The arithmetic that makes universal screening unattractive, and cascade testing worth building. 442 screening tests to prevent one case; 1,474 to 8,840 to prevent one death, depending on the case-fatality rate assumed; US$332 per person screened; cost-saving only below roughly US$37 for a point-of-care test. These are Hong Kong 2014 costs in a population with a far higher allele frequency than India, and do not transfer without adjustment. Note the title: this is framed as a real-world efficiency analysis, not a cost-effectiveness analysis.',
    },
    {
      id: 'ev-cost-malaysia',
      citation:
        'Chong HY, Mohamed Z, Tan LL, et al. Is universal HLA-B*15:02 screening a cost-effective option in an ethnically diverse population? A case study of Malaysia. Br J Dermatol. 2017 Oct;177(4):1102-1112.',
      pmid: '28346659',
      doi: '10.1111/bjd.15498',
      studyDesign: 'cost-effectiveness analysis',
      population: 'Malaysian, multi-ethnic', country: 'Malaysia',
      verificationStatus: 'verified_primary_source',
      verifiedUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5617756/',
      quality_notes:
        'In a base-case analysis in an ethnically diverse population, universal screening was dominated by current practice: more costly and less effective. The closest published analogue to the Indian situation, and the strongest external argument for not attempting universal screening here.',
    },
  ],

  /**
   * Population frequencies. This table is where the Indian contribution
   * accumulates, and where the case for cascade testing is actually made:
   * cascade enrichment is only worth the trouble where population frequency
   * is low enough to make universal screening uneconomic.
   *
   * Note the figure recorded here (2.1%, range 0 to 14.2%) differs from the
   * 2.5% with range 0 to 6% that circulates in secondary summaries. The
   * value here is the one found in the cited source. Where the two
   * disagree, the source wins and the discrepancy is recorded rather than
   * quietly reconciled.
   */
  populationFrequencies: [
    {
      geneSymbol: 'HLA-B', alleleName: '*15:02',
      population: 'Indian (pooled, Allele Frequency Net Database)',
      alleleFreq: 0.021,
      sampleN: 714,
      sourceId: 'ev-freq-india',
    },
    {
      geneSymbol: 'HLA-B', alleleName: '*15:02',
      population: 'Indian sub-population, highest reported',
      region: 'North-East India cohort',
      alleleFreq: 0.142,
      sourceId: 'ev-freq-india',
    },
    {
      geneSymbol: 'HLA-B', alleleName: '*15:02',
      population: 'Indian sub-population, lowest reported',
      region: 'West Coast Parsi cohort',
      alleleFreq: 0.0,
      sourceId: 'ev-freq-india',
    },
    {
      geneSymbol: 'HLA-B', alleleName: '*15:02',
      population: 'South-East Asian (regional comparator)',
      alleleFreq: 0.056,
      sourceId: 'ev-freq-india',
    },
  ],

  wordingRules: WORDING_RULES,
};
