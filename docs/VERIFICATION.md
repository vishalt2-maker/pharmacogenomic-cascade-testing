# Citation and figure verification

> "Verify every figure in this document against its primary source before putting
> it on a slide. Do not cite anything you have not personally opened."
> — Master Build Planogram v1.0

This file records what was checked during the build, how, and — more importantly
— what was **not**.

## Status of this verification

Citations were checked against the **NCBI E-utilities MEDLINE records** and the
publishers' own pages. That is a machine verification against a primary
bibliographic record. It is a real step above transcription and it is **not a
human curator having read the paper**.

The rule pack therefore remains at provenance status `demonstration`. The safety
engine refuses to issue from it unless a deployment explicitly opts in, and the
renderer stamps a banner on every page. Promotion to `curated_verified` requires
a named human to open each source.

## Verified

| Item | Citation | PMID | DOI |
|---|---|---|---|
| Carbamazepine guideline | Phillips EJ, Sukasem C, Whirl-Carrillo M, et al. CPIC Guideline for HLA Genotype and Use of Carbamazepine and Oxcarbazepine: 2017 Update. *Clin Pharmacol Ther*. 2018 Apr;103(4):574-581. | 29392710 | 10.1002/cpt.1004 |
| Phenytoin guideline | Karnes JH, Rettie AE, Somogyi AA, et al. CPIC Guideline for CYP2C9 and HLA-B Genotypes and Phenytoin Dosing: 2020 Update. *Clin Pharmacol Ther*. 2021 Feb;109(2):302-309. | 32779747 | 10.1002/cpt.2008 |
| Indian association study | Mehta TY, Prajapati LM, Mittal B, et al. Association of HLA-B\*1502 allele and carbamazepine-induced Stevens-Johnson syndrome among Indians. *Indian J Dermatol Venereol Leprol*. 2009 Nov-Dec;75(6):579-582. | 19915237 | 10.4103/0378-6323.57718 |
| Screening efficiency | Chen Z, Liew D, Kwan P. Real-world efficiency of pharmacogenetic screening for carbamazepine-induced severe cutaneous adverse reactions. *PLoS One*. 2014;9(5):e96990. | 24806465 | 10.1371/journal.pone.0096990 |
| Malaysian cost-effectiveness | Chong HY, Mohamed Z, Tan LL, et al. Is universal HLA-B\*15:02 screening a cost-effective option in an ethnically diverse population? A case study of Malaysia. *Br J Dermatol*. 2017 Oct;177(4):1102-1112. | 28346659 | 10.1111/bjd.15498 |
| Indian allele frequency | Biswas M, Murad MA, Ershadian M, Sukasem C. Investigation of the Prevalence of the HLA-B\*15:02 Allele in the Asian Populations. *Health Sci Rep*. 2026 Aug;9(8):e72903. | 42524381 | 10.1002/hsr2.72903 |

Verified figures, with their caveats, live in `db/seed/context-figures.ts` and are
served at `GET /api/figures`. Nothing in the user interface, the demonstration or
the documents may state a figure that is not in that file.

## Platform changes worth knowing

| Event | Date |
|---|---|
| PharmGKB rebranded to ClinPGx; `pharmgkb.org` redirects to `clinpgx.org` | 30 July 2025 |
| CPIC website moved to ClinPGx; `cpicpgx.org` URLs redirect | 9 March 2026 |
| `api.pharmgkb.org` retired in favour of `api.clinpgx.org` | 20 July 2026 |

The **CPIC API base URL did not change**: it remains `https://api.cpicpgx.org/v1/`.
That is a different service from the ClinPGx API. The canonical URL for the
carbamazepine guideline is now `https://www.clinpgx.org/guideline/PA166251448`.

The gene table's `pharmgkbid` column was renamed `clinpgxid`. This build uses the
new name throughout (`knowledge.genes.clinpgx_id`).

## NOT verified — read this part

**1. Control-group statistics in the Indian association study.** The 6-of-8 case
figure is solid and confirmed from two independent sources. The control-group
counts, the odds ratio and the p-value were **not** confirmed verbatim and are
deliberately absent from the rule pack. Do not put them on a slide.

**2. The Indian frequency data are thinner than the headline.** The 2.1% mean
rests on **n = 714 individuals for the whole of India**. Only two sub-populations
were named in the retrieved text (a North-East cohort at 14.2%, a West Coast
Parsi cohort at 0%). The full per-community breakdown lives in supplementary
material that was not retrieved. **If any risk calculation in this system ever
depends on allele frequency, this source is too thin to carry it.**

**3. "Actionability, not evidence" has no current normative page.** The statement
was located only in a CPIC-authored slide deck from March 2021, in the
`cpicpgx.org` uploads directory. The four separately graded dimensions are well
supported and are what this build implements. The crisp framing should not be
quoted as normative without written confirmation from CPIC.

**4. SJS and TEN mortality figures genuinely disagree.**

| Source | SJS | TEN |
|---|---|---|
| CPIC 2017 guideline | below 5% | above 30% |
| MedlinePlus Genetics | about 10% | up to 50% |
| StatPearls | 34–50% combined | 30% |

CPIC's figures are used for internal consistency with the rest of the guidance.
Any single number is defensible only against the source cited beside it.
SJS/TEN-overlap mortality was not verified from any source and is not stated.

**5. Licence terms were read through a rendering proxy, not directly.** The
ClinPGx site serves an empty shell to direct fetches. The licence findings in
`docs/GOVERNANCE.md` came through a third-party text renderer. **If the licence
terms are load-bearing for a commercial product, confirm them in a real browser
and get the answer in writing.**

**6. Hong Kong figures do not transfer to India.** The 442, the US$332 and the
US$37 threshold are Hong Kong 2014 costs in a population with a considerably
higher allele frequency than India's. They make the argument that universal
screening is unattractive. They are not Indian numbers and must not be presented
as such.

## How to promote the pack to `curated_verified`

1. A named human opens every source in `RULE_PACK.evidence` and confirms the
   citation, the figures drawn from it, and that the paraphrased recommendation
   text does not misstate the guideline.
2. Set each `verificationStatus` to `verified_primary_source` with
   `verifiedBy` and `verifiedAt`.
3. Set `provenanceStatus` to `curated_verified`.
4. Re-run `npm run seed`. The hash changes, which is the point: a different pack
   produced different advice.
5. Confirm the licence position in writing first. See `docs/GOVERNANCE.md`.
