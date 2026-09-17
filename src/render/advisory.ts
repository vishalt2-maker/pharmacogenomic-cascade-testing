/**
 * THE ADVISORY RENDERER.
 *
 * Produces TWO documents, never one:
 *
 *   1. A clinical advisory, addressed to the future prescribing clinician.
 *      Technical register. Star alleles, guideline citation, phenotype terms.
 *   2. A patient companion sheet, plain language, in the patient's
 *      preferred language where a translation exists.
 *
 * Never make the patient read the clinical document. Never let the clinical
 * document be simplified into vagueness.
 *
 * Both are linted before either is returned. If the linter refuses, nothing
 * is rendered at all -- a half-rendered pair is how a patient ends up
 * holding a document that was never checked.
 *
 * What is produced here is a frozen content snapshot, not a template
 * reference. If the template changes next year, the issued document must
 * still be reproducible exactly as issued.
 */
import { sha256, canonicalJson } from '../knowledge/hash.ts';
import { lintOrRefuse, type DocumentBlock, type DocumentProfile } from './linter.ts';
import { INDIA_TIER_DEFINITIONS, type EvaluationResult, type RulePack } from '../engine/types.ts';
import { figure } from '../../db/seed/context-figures.ts';

export interface SignatoryInput {
  fullName: string;
  registrationNo: string;
  registrationBody: string;
}

export interface RenderInput {
  evaluation: EvaluationResult;
  rulePack: RulePack;
  signatory: SignatoryInput;
  issuedOn: Date;
  organisationName: string;
  /** Free-text laboratory provenance, straight from the genotype result. */
  labName: string;
  labAccreditation: string;
  method: string;
  reportRef: string;
  resultedAt: string;
  preferredLanguage?: string;
  /** Aggregate only: relationship type and count. Never names. */
  recipientSummary?: Array<{ relationshipType: string; count: number }>;
}

export interface RenderedDocument {
  profile: DocumentProfile;
  title: string;
  language: string;
  blocks: DocumentBlock[];
}

export interface RenderedAdvisory {
  clinical: RenderedDocument;
  patient: RenderedDocument;
  contentHash: string;
  /** Present when the pack is not clinically curated. Printed on every page. */
  banner: string | null;
}

const SUPPORTED_PATIENT_LANGUAGES = ['en', 'hi'] as const;
type PatientLanguage = typeof SUPPORTED_PATIENT_LANGUAGES[number];

function fmtDate(d: Date | string): string {
  const dt = typeof d === 'string' ? new Date(d) : d;
  return dt.toISOString().slice(0, 10);
}

/**
 * The banner for a pack that is not clinically curated. Not a footnote:
 * it is the first block of both documents.
 */
function provenanceBanner(pack: RulePack): string | null {
  if (pack.provenanceStatus === 'curated_verified') return null;
  if (pack.provenanceStatus === 'demonstration') {
    return 'CONCEPT BUILD — DEMONSTRATION RULE PACK. This document was produced from a rule pack marked as demonstration content. It is not clinically curated, has not been validated, and has no regulatory approval of any kind. It must not be used to make a prescribing decision.';
  }
  return 'RULE PACK NOT FULLY VERIFIED. One or more sources cited by this rule pack have not been checked against a primary source by a human curator.';
}

// =====================================================================
// CLINICAL ADVISORY
// =====================================================================
function renderClinical(input: RenderInput, banner: string | null): RenderedDocument {
  const { evaluation: ev, rulePack: pack, signatory: sig } = input;
  const f = ev.finding;
  if (!f) {
    throw new Error(
      'RENDER_REFUSED: no resolved finding. The renderer is never invoked on ' +
      'an evaluation that produced nothing.');
  }

  const cautioned = f.alternatives.filter((a) => a.cautionFlag);
  const uncautioned = f.alternatives.filter((a) => !a.cautionFlag);
  const ppv = figure('index_ppv_cbz');

  const blocks: DocumentBlock[] = [];

  if (banner) blocks.push({ key: 'banner', heading: 'STATUS OF THIS DOCUMENT', body: banner });

  blocks.push({
    key: 'addressee',
    heading: 'For the attention of a future prescribing clinician',
    body:
      'This advisory concerns a pharmacogenomic finding in the named individual, confirmed by an accredited laboratory following a severe cutaneous adverse drug reaction. It is issued to the individual, to be presented to any clinician considering the drugs named below. It does not authorise, require or replace any clinical decision.',
  });

  blocks.push({
    key: 'finding',
    heading: 'Finding',
    body: [
      `Gene: ${f.pair.geneSymbol}`,
      `Diplotype as reported: ${f.diplotype}`,
      `Phenotype: ${f.phenotype.term}`,
      `Gene-drug pair: ${f.pair.geneSymbol} and ${f.pair.drugName}`,
      `Action: ${f.recommendation.actionCode.replace(/_/g, ' ')}`,
    ],
  });

  blocks.push({
    key: 'recommendation',
    heading: 'Published guidance for this phenotype',
    body: [
      f.recommendation.clinicalText,
      f.recommendation.implicationsText ?? '',
    ].filter(Boolean),
  });

  blocks.push({
    key: 'provenance_genotype',
    heading: 'Provenance of the genotype',
    body: [
      `Laboratory: ${input.labName}`,
      `Accreditation: ${input.labAccreditation}`,
      `Method: ${input.method}`,
      `Laboratory report reference: ${input.reportRef}`,
      `Date resulted: ${fmtDate(input.resultedAt)}`,
      'Entered and independently verified by two separate registered users of the issuing centre.',
    ],
  });

  blocks.push({
    key: 'provenance_rule',
    heading: 'Provenance of the guidance',
    body: [
      `Guideline: ${f.pair.guidelineCitation}`,
      `Guideline version: ${f.pair.guidelineVersion}`,
      f.pair.guidelinePmid ? `PMID: ${f.pair.guidelinePmid}` : '',
      f.pair.guidelineDoi ? `DOI: ${f.pair.guidelineDoi}` : '',
      `Rule pack version: ${pack.version} (content hash ${pack.contentHash.slice(0, 16)}…)`,
      `Safety engine: ${ev.engineVersion}`,
      `Evaluated: ${fmtDate(ev.evaluatedAt)}`,
      `Date of issue: ${fmtDate(input.issuedOn)}`,
      `Issuing centre: ${input.organisationName}`,
    ].filter(Boolean),
  });

  // DIMENSION 5, printed. A clinician reading IN-2 knows what they are
  // holding. A clinician reading an unqualified "CPIC Level A" does not.
  blocks.push({
    key: 'india_evidence_tier',
    heading: `India Evidence Tier: ${f.indiaEvidenceTier}`,
    body: [
      INDIA_TIER_DEFINITIONS[f.indiaEvidenceTier],
      f.pair.indiaTierRationale ?? '',
      'This tier describes the strength of the INDIAN evidence base specifically. It is separate from, and does not restate, the actionability level or the evidence strength assigned by the guideline authors.',
      `Actionability level assigned by the guideline: ${f.pair.cpicActionability}. This is a level of actionability, describing whether prescribing should change. It is not a level of evidence.`,
      `Strength of the published recommendation: ${f.recommendation.recommendationStrength}.`,
      f.pair.evidenceStrength
        ? `Strength of evidence for the underlying findings: ${f.pair.evidenceStrength}.`
        : '',
    ].filter(Boolean),
  });

  blocks.push({
    key: 'alternatives_caution',
    heading: 'Alternatives, and their own cautions',
    body: [
      'Drug selection remains the prescribing clinician’s decision. The following is what the cited guidance says about the alternatives, including where the alternative carries a caution of its own.',
      ...cautioned.map((a) => `${a.drugName}: ${a.cautionText}`),
      uncautioned.length > 0
        ? `No HLA-B*15:02 caution is recorded in this rule pack for: ${uncautioned.map((a) => a.drugName).join(', ')}. Absence of a caution here is not a positive endorsement; it means this pack records no such signal.`
        : '',
    ].filter(Boolean),
  });

  blocks.push({
    key: 'non_determinism',
    heading: 'What this finding does not mean',
    body: [
      'Carrying this variant does not mean this person will experience a severe reaction. It means these specific drugs should be avoided.',
      `The cited guidance reports a positive predictive value of ${ppv.value} for the association between this variant and ${f.pair.drugName === 'carbamazepine' ? 'carbamazepine-induced' : 'carbamazepine-induced'} Stevens-Johnson Syndrome or Toxic Epidermal Necrolysis. The great majority of carriers exposed to the drug do not develop a severe cutaneous reaction.`,
    ],
  });

  blocks.push({
    key: 'familial_probability',
    heading: 'Implication for first-degree relatives',
    body: [
      'Each first-degree relative of this individual has approximately a 50 per cent probability of carrying the same variant. This is a probability, not a diagnosis, and it applies to relatives who have not been tested.',
      'Testing and genetic counselling are available. A relative who wishes to be tested should present in their own right and give their own consent.',
      'This system holds no record of any relative. It does not contact relatives, and cannot.',
    ],
  });

  blocks.push({
    key: 'right_not_to_know',
    heading: 'The right not to know',
    body:
      'Relatives are under no obligation to be tested, and may decline to receive this information. Sharing this advisory is entirely the decision of the individual to whom it is issued.',
  });

  blocks.push({
    key: 'limits',
    heading: 'Limits of this advisory',
    body: [
      f.pair.negativeResultCaution,
      'This advisory addresses one gene and the drugs named. It does not address other genes, other drugs, or non-genetic risk factors.',
      `The rule pack that produced this document expires on ${fmtDate(pack.expiresAt)}. After that date the issuing system will not produce further advisories from it, because allele definitions and published guidance are revised over time.`,
    ],
  });

  blocks.push({
    key: 'financial_interests',
    heading: 'Declaration of financial interests',
    body:
      'The issuing system receives no commission, referral fee or per-test revenue in connection with this advisory. No laboratory is recommended or steered to. Any testing of relatives is arranged independently by the treating clinician and the individual concerned.',
  });

  if (input.recipientSummary && input.recipientSummary.length > 0) {
    blocks.push({
      key: 'recipient_summary',
      heading: 'Counselling record (aggregate)',
      body: [
        'Discussed at counselling, recorded as relationship type and count only. No relative is named or recorded by this system.',
        ...input.recipientSummary.map((r) => `${r.relationshipType}: ${r.count}`),
      ],
    });
  }

  blocks.push({
    key: 'signatory',
    heading: 'Signed',
    body: [
      `${sig.fullName}`,
      `Registration number: ${sig.registrationNo} (${sig.registrationBody})`,
      `${input.organisationName}`,
      `Date: ${fmtDate(input.issuedOn)}`,
      'This advisory was reviewed and signed by the named clinician. It is issued under their clinical responsibility.',
    ],
  });

  return {
    profile: 'clinical',
    title: 'Familial Pharmacogenomic Advisory',
    language: 'en',
    blocks,
  };
}

// =====================================================================
// PATIENT COMPANION SHEET
// =====================================================================
const PATIENT_TEXT: Record<PatientLanguage, Record<string, string | string[]>> = {
  en: {
    title: 'Your medicine safety information',
    what_this_is: [
      'You had a serious skin reaction to a medicine. A laboratory test has found that you carry a common variant in one of your genes.',
      'This variant is linked to that kind of reaction with a small group of medicines. This sheet tells you which ones.',
      'A variant is not a disease. Many healthy people carry it.',
    ],
    what_to_do: [
      'Keep the doctor’s letter that came with this sheet.',
      'Show it to any doctor, dentist or pharmacist before you start a new medicine.',
      'Show it especially if a medicine for fits or seizures is suggested.',
      'Do not stop a medicine you are already taking because of this sheet. Speak to your doctor first.',
    ],
    non_determinism: [
      'Carrying this variant does not mean you will experience a serious reaction.',
      'It means that a small number of specific medicines are better avoided in your case, and that other medicines can be used instead.',
      'Your doctor will choose which medicine is right for you.',
    ],
    familial_probability: [
      'Close blood relatives, meaning your parents, your brothers and sisters, and your children, each have roughly a one in two chance of carrying the same variant.',
      'That is a chance, not a diagnosis. Nobody can know without a test.',
      'If they wish, they can ask their own doctor about being tested, and about speaking to a counsellor first.',
    ],
    right_not_to_know: [
      'Your relatives do not have to be tested. They may choose not to know.',
      'That choice is theirs, and it is a reasonable one.',
    ],
    sharing_is_your_choice: [
      'Whether you tell your family about this is your decision alone.',
      'This clinic will not contact your relatives. It holds no record of who they are.',
      'If you would like help explaining it to them, ask the clinic and someone will sit with you.',
    ],
  },
  hi: {
    title: 'आपकी दवा सुरक्षा जानकारी',
    what_this_is: [
      'आपको एक दवा से त्वचा की गंभीर प्रतिक्रिया हुई थी। जाँच में पता चला है कि आपके जीन में एक आम बदलाव है।',
      'यह बदलाव कुछ गिनी-चुनी दवाओं के साथ ऐसी प्रतिक्रिया से जुड़ा है। यह पर्चा बताता है कि वे कौन सी हैं।',
      'यह बदलाव कोई बीमारी नहीं है। बहुत से स्वस्थ लोगों में यह पाया जाता है।',
    ],
    what_to_do: [
      'डॉक्टर का पत्र संभालकर रखें।',
      'कोई भी नई दवा शुरू करने से पहले उसे डॉक्टर या फार्मासिस्ट को दिखाएँ।',
      'मिर्गी की दवा की सलाह मिलने पर यह खास तौर पर ज़रूरी है।',
      'पहले से चल रही दवा इस पर्चे के कारण खुद से बंद न करें। पहले डॉक्टर से बात करें।',
    ],
    non_determinism: [
      'यह बदलाव होने का मतलब यह नहीं कि आपको गंभीर प्रतिक्रिया होगी ही।',
      'इसका मतलब है कि कुछ गिनी-चुनी दवाएँ आपके लिए न लेना बेहतर है, और उनकी जगह दूसरी दवाएँ दी जा सकती हैं।',
      'आपके लिए सही दवा आपके डॉक्टर चुनेंगे।',
    ],
    familial_probability: [
      'आपके नज़दीकी रक्त संबंधी — माता-पिता, भाई-बहन और बच्चे — में से हर एक में यही बदलाव होने की संभावना लगभग आधी है।',
      'यह संभावना है, निदान नहीं। बिना जाँच के कोई नहीं जान सकता।',
      'अगर वे चाहें, तो अपने डॉक्टर से जाँच और परामर्श के बारे में पूछ सकते हैं।',
    ],
    right_not_to_know: [
      'आपके रिश्तेदारों के लिए जाँच कराना ज़रूरी नहीं है। वे न जानना भी चुन सकते हैं।',
      'यह उनका अपना फैसला है, और यह एक उचित फैसला है।',
    ],
    sharing_is_your_choice: [
      'परिवार को बताना या नहीं, यह पूरी तरह आपका फैसला है।',
      'यह क्लिनिक आपके रिश्तेदारों से संपर्क नहीं करेगा। उनका कोई रिकॉर्ड यहाँ नहीं रखा जाता।',
      'अगर समझाने में मदद चाहिए, तो क्लिनिक से कहें।',
    ],
  },
};

function renderPatient(input: RenderInput, banner: string | null): RenderedDocument {
  const f = input.evaluation.finding!;
  const requested = (input.preferredLanguage ?? 'en').toLowerCase().slice(0, 2);
  const lang: PatientLanguage =
    (SUPPORTED_PATIENT_LANGUAGES as readonly string[]).includes(requested)
      ? requested as PatientLanguage : 'en';
  const t = PATIENT_TEXT[lang];

  const blocks: DocumentBlock[] = [];
  if (banner) blocks.push({ key: 'banner', heading: 'STATUS', body: banner });

  blocks.push({ key: 'what_this_is', heading: 'What this is about', body: t.what_this_is });

  // Drug names stay in Latin script deliberately: the patient must be able
  // to match them against a strip of tablets and a prescription.
  blocks.push({
    key: 'which_medicines',
    heading: 'Medicines to avoid',
    body: [
      f.pair.drugName,
      ...f.alternatives.filter((a) => a.cautionFlag).map((a) => a.drugName),
    ].map((d) => `• ${d}`),
  });

  blocks.push({ key: 'what_to_do', heading: 'What to do', body: t.what_to_do });
  blocks.push({ key: 'non_determinism', heading: 'What this does not mean', body: t.non_determinism });
  blocks.push({ key: 'familial_probability', heading: 'Your family', body: t.familial_probability });
  blocks.push({ key: 'right_not_to_know', heading: 'They do not have to be tested', body: t.right_not_to_know });
  blocks.push({ key: 'sharing_is_your_choice', heading: 'Telling your family is your choice', body: t.sharing_is_your_choice });

  blocks.push({
    key: 'signatory',
    heading: 'Given to you by',
    body: [
      `${input.signatory.fullName}`,
      `Registration number: ${input.signatory.registrationNo} (${input.signatory.registrationBody})`,
      `${input.organisationName}`,
      `Date: ${fmtDate(input.issuedOn)}`,
    ],
  });

  return {
    profile: 'patient',
    title: String(t.title),
    language: lang,
    blocks,
  };
}

// =====================================================================
export function renderAdvisory(input: RenderInput): RenderedAdvisory {
  const banner = provenanceBanner(input.rulePack);
  const clinical = renderClinical(input, banner);
  const patient = renderPatient(input, banner);

  // Lint BOTH before returning EITHER.
  lintOrRefuse(clinical.blocks, input.rulePack.wordingRules, 'clinical');
  lintOrRefuse(patient.blocks, input.rulePack.wordingRules, 'patient');

  const contentHash = sha256(canonicalJson({ clinical, patient }));
  return { clinical, patient, contentHash, banner };
}

/** Plain-text rendering, used for the PDF and the console preview. */
export function toPlainText(doc: RenderedDocument): string {
  const out: string[] = [doc.title.toUpperCase(), '='.repeat(doc.title.length), ''];
  for (const b of doc.blocks) {
    if (b.heading) { out.push(b.heading, '-'.repeat(b.heading.length)); }
    const body = Array.isArray(b.body) ? b.body : [b.body];
    out.push(...body, '');
  }
  return out.join('\n');
}
