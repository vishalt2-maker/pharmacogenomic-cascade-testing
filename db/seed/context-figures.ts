/**
 * VERIFIED CONTEXT FIGURES.
 *
 * Every number the application displays outside a laboratory result lives
 * here, with the source it came from and whether that source was actually
 * opened. Nothing in the user interface, the demo or the documentation may
 * state a figure that is not in this file.
 *
 * Where a widely repeated secondary figure disagrees with the primary
 * source, both are recorded and the disagreement is shown rather than
 * silently resolved.
 */
export interface Figure {
  key: string;
  label: string;
  value: string;
  source: string;
  sourceUrl: string;
  verified: boolean;
  caveat?: string;
}

export const FIGURES: readonly Figure[] = Object.freeze([
  {
    key: 'nns_case',
    label: 'Screening tests needed to prevent one case of carbamazepine-induced SJS/TEN',
    value: '442',
    source: 'Chen Z, Liew D, Kwan P. PLoS One. 2014;9(5):e96990.',
    sourceUrl: 'https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0096990',
    verified: true,
    caveat: 'Hong Kong, 2014, in a population with a considerably higher HLA-B*15:02 frequency than India.',
  },
  {
    key: 'nns_death',
    label: 'Screening tests needed to prevent one death',
    value: '1,474 to 8,840',
    source: 'Chen Z, Liew D, Kwan P. PLoS One. 2014;9(5):e96990.',
    sourceUrl: 'https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0096990',
    verified: true,
    caveat: 'A range, not a point estimate. The spread depends entirely on the case-fatality rate assumed. Quoting a single number here is an error whichever number is chosen.',
  },
  {
    key: 'cost_per_screen',
    label: 'Cost per person screened',
    value: 'USD 332',
    source: 'Chen Z, Liew D, Kwan P. PLoS One. 2014;9(5):e96990.',
    sourceUrl: 'https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0096990',
    verified: true,
    caveat: 'Hong Kong 2014 costs. 42% of the figure was an additional consultation to review the result and prescribe, not the assay.',
  },
  {
    key: 'poc_threshold',
    label: 'Point-of-care test price below which screening becomes cost-saving',
    value: 'under USD 37',
    source: 'Chen Z, Liew D, Kwan P. PLoS One. 2014;9(5):e96990.',
    sourceUrl: 'https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0096990',
    verified: true,
  },
  {
    key: 'malaysia',
    label: 'Universal screening in an ethnically diverse population',
    value: 'dominated by current practice: more costly and less effective',
    source: 'Chong HY, et al. Br J Dermatol. 2017;177(4):1102-1112.',
    sourceUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5617756/',
    verified: true,
  },
  {
    key: 'india_freq',
    label: 'HLA-B*15:02 allele frequency, India',
    value: '2.1% (SD 1.5), range 0% to 14.2% across sub-populations',
    source: 'Biswas M, et al. Health Sci Rep. 2026;9(8):e72903.',
    sourceUrl: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC13411286/',
    verified: true,
    caveat: 'Based on n=714 individuals for the whole of India. Far too thin to carry a risk calculation. Widely repeated secondary summaries give 2.5% with a range of 0 to 6%; that range disagrees with this source at the upper end and no primary source was found for it.',
  },
  {
    key: 'mortality',
    label: 'Mortality, SJS and TEN',
    value: 'typically below 5% for SJS; above 30% for TEN',
    source: 'CPIC guideline for HLA genotype and use of carbamazepine and oxcarbazepine, 2017 update.',
    sourceUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5847474/',
    verified: true,
    caveat: 'Sources genuinely disagree. MedlinePlus Genetics gives about 10% for SJS and up to 50% for TEN. The CPIC figures are used here for internal consistency with the rest of the guidance, not because the disagreement is resolved.',
  },
  {
    key: 'index_ppv_cbz',
    label: 'Positive predictive value of HLA-B*15:02 for carbamazepine-induced SJS/TEN',
    value: '7.7%',
    source: 'CPIC guideline for HLA genotype and use of carbamazepine and oxcarbazepine, 2017 update.',
    sourceUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5847474/',
    verified: true,
    caveat: 'Directly relevant to the non-determinism clause: most carriers exposed to the drug do not develop a severe cutaneous reaction. The corresponding figure for oxcarbazepine is 0.73%.',
  },
  {
    key: 'indian_study_n',
    label: 'Carbamazepine-SJS patients genotyped in the principal Indian association study',
    value: '8 patients, of whom 6 carried HLA-B*1502',
    source: 'Mehta TY, et al. Indian J Dermatol Venereol Leprol. 2009;75(6):579-582.',
    sourceUrl: 'https://ijdvl.com/association-of-hla-b1502-allele-and-carbamazepine-induced-stevens-johnson-syndrome-among-indians/',
    verified: true,
    caveat: 'This is the size of the direct Indian evidence base. It is the reason for the India Evidence Tier, and the reason the registry is the point of the exercise.',
  },
  {
    key: 'first_degree_prior',
    label: 'Prior probability that a first-degree relative of a confirmed carrier carries the variant',
    value: 'approximately 50%',
    source: 'Mendelian inheritance of a heterozygous carrier state. Not an empirical finding.',
    sourceUrl: '',
    verified: true,
    caveat: 'This is arithmetic, not evidence, and it assumes the index carrier is heterozygous. It is the falsifiable prediction the pilot must test: if carrier yield in tested relatives returns at population baseline rather than near 50%, the thesis is wrong.',
  },
]);

export function figure(key: string): Figure {
  const f = FIGURES.find((x) => x.key === key);
  if (!f) throw new Error(`No verified figure for key "${key}". Add it with its source, or do not state it.`);
  return f;
}
