/**
 * SECTION 6 SAFETY WORDING RULES, as data.
 *
 * These are enforced at render time as VALIDATION, not guidance: a linter
 * that refuses to render a document containing a banned construction. They
 * ship inside the rule pack and are versioned with it, so an advisory
 * issued in 2026 can be re-linted in 2031 against the rules that actually
 * applied when it was issued.
 */
import type { WordingRule } from '../../src/engine/types.ts';

/**
 * A negation guard. Most banned constructions are only banned when
 * ASSERTED -- the mandatory non-determinism clause must be able to say
 * "does not mean this person will experience a severe reaction", and the
 * mandatory negative-result clause must be able to say "does not eliminate
 * the risk". This matches a negation in the preceding context.
 */
const NEGATED =
  "(?:\\b(?:not|never|no|cannot|does\\s+not|do\\s+not|doesn't|don't|isn't|is\\s+not)\\b[^.;]{0,60})$";

export const WORDING_RULES: WordingRule[] = [
  // ---- banned: false reassurance ------------------------------------
  {
    ruleCode: 'BAN_CLEARED',
    kind: 'banned', appliesTo: 'both',
    pattern: '\\b(cleared|clearance|clears\\s+(?:them|him|her|the\\s+patient))\\b',
    rationale:
      'Implies eliminated risk, which is false. A negative result does not eliminate the risk of a severe cutaneous reaction.',
  },
  {
    ruleCode: 'BAN_SAFE',
    kind: 'banned', appliesTo: 'both',
    pattern: '\\b(safe|safely|genetically\\s+safe)\\b',
    exemptIfPrecededBy: NEGATED,
    rationale:
      'Describing a drug or a person as safe asserts an absence of risk the genotype cannot support.',
  },
  {
    ruleCode: 'BAN_NO_RISK',
    kind: 'banned', appliesTo: 'both',
    pattern: '\\b(no\\s+risk|zero\\s+risk|risk[- ]free|eliminates?\\s+(?:the\\s+)?risk|rules?\\s+out\\s+(?:the\\s+)?risk)\\b',
    exemptIfPrecededBy: NEGATED,
    rationale:
      'Asserting absence of risk creates a false-reassurance harm pathway that did not previously exist.',
  },
  {
    ruleCode: 'BAN_GUARANTEE',
    kind: 'banned', appliesTo: 'both',
    pattern: '\\b(guarantee[sd]?|100\\s*%|certainly\\s+will)\\b',
    rationale: 'The system states published guidance and laboratory findings. It guarantees nothing.',
  },

  // ---- banned: prognostic assertion ---------------------------------
  {
    ruleCode: 'BAN_WILL_DEVELOP',
    kind: 'banned', appliesTo: 'both',
    pattern: '\\bwill\\s+(develop|get|suffer|experience|have)\\b',
    exemptIfPrecededBy: NEGATED,
    rationale:
      'Carrying an allele is not a prognosis. Most carriers exposed to the drug do not develop a severe reaction.',
  },

  // ---- banned: genetic fatalism in patient-facing text --------------
  {
    ruleCode: 'BAN_DANGER_CARD',
    kind: 'banned', appliesTo: 'both',
    pattern: '\\b(danger\\s+card|risk\\s+card|death\\s+card)\\b',
    rationale: 'Induces genetic fatalism. Terrified patients refuse treatment.',
  },
  {
    ruleCode: 'BAN_GENETIC_DEFECT',
    kind: 'banned', appliesTo: 'both',
    pattern: '\\b(genetic\\s+defect|defective\\s+gene|faulty\\s+gene|bad\\s+gene)\\b',
    rationale: 'Stigmatising and inaccurate. Use "variant".',
  },
  {
    ruleCode: 'BAN_MUTATION',
    kind: 'banned', appliesTo: 'patient',
    pattern: '\\bmutations?\\b',
    rationale:
      'In patient-facing text "mutation" induces genetic fatalism. Use "variant". The term remains available in the clinical document.',
  },
  {
    ruleCode: 'BAN_ABNORMAL',
    kind: 'banned', appliesTo: 'patient',
    pattern: '\\b(abnormal|diseased|afflicted)\\b',
    rationale: 'A common pharmacogenomic variant is not an abnormality.',
  },

  // ---- banned: claims about people who have not been tested ---------
  {
    ruleCode: 'BAN_CONFIRMED_CARRIER_RELATIVE',
    kind: 'banned', appliesTo: 'both',
    // Contextual: the phrase is legitimate about the index patient and
    // false about an untested relative, so the relative term must be within
    // the same sentence.
    pattern:
      '\\b(confirmed|known|proven)\\s+carriers?\\b[^.;]{0,80}\\b(relative|relatives|sibling|siblings|brother|sister|parent|parents|mother|father|child|children|son|daughter|family)\\b'
      + '|\\b(relative|relatives|sibling|siblings|brother|sister|parent|parents|mother|father|child|children|son|daughter)\\b[^.;]{0,80}\\b(is|are)\\s+(?:a\\s+)?(confirmed|known|proven)\\s+carriers?\\b',
    rationale:
      'A relative who has not been tested is not a confirmed carrier. They have approximately a 50% probability, which is a probability and not a diagnosis.',
  },

  // ---- banned: referral steering and conflict of interest -----------
  {
    ruleCode: 'BAN_REFERRAL_STEERING',
    kind: 'banned', appliesTo: 'both',
    pattern:
      '\\b(recommended\\s+lab(?:oratory)?|preferred\\s+lab(?:oratory)?|our\\s+lab(?:oratory)?|book\\s+(?:here|now|online)|order\\s+here|use\\s+this\\s+lab)\\b',
    rationale:
      'No commission, no tracked links, no per-test revenue. Commission-for-referral is prohibited under the medical ethics regulations in force.',
  },
  {
    ruleCode: 'BAN_TRACKED_LINK',
    kind: 'banned', appliesTo: 'both',
    pattern: 'https?://\\S*[?&](?:utm_[a-z]+|ref|refid|aff|affiliate|src|partner)=',
    rationale: 'A tracked link is referral steering wearing a URL.',
  },

  // ---- banned: misattributing the clinical decision ------------------
  {
    ruleCode: 'BAN_SYSTEM_RECOMMENDS',
    kind: 'banned', appliesTo: 'both',
    pattern:
      '\\b(?:the\\s+)?(system|software|tool|algorithm|application|platform|AI)\\s+(recommends?|advises?|suggests?|decides?|prescribes?|determines?)\\b',
    rationale:
      'The clinician recommends. The system displays published guidance and the clinician decides.',
  },
  {
    ruleCode: 'BAN_DIAGNOSES',
    kind: 'banned', appliesTo: 'both',
    pattern: '\\b(?:the\\s+)?(system|software|tool|algorithm|test)\\s+diagnos(?:es|ed|is)\\b',
    rationale: 'Nothing here diagnoses. An accredited laboratory reports a genotype.',
  },

  // ---- mandatory clauses: clinical advisory --------------------------
  { ruleCode: 'MUST_ADDRESSEE', kind: 'mandatory', appliesTo: 'clinical', clauseKey: 'addressee',
    rationale: 'For the attention of a future prescribing clinician.' },
  { ruleCode: 'MUST_PROVENANCE_GENOTYPE', kind: 'mandatory', appliesTo: 'clinical', clauseKey: 'provenance_genotype',
    rationale: 'Confirmed index genotype, test date, accredited laboratory, method.' },
  { ruleCode: 'MUST_PROVENANCE_RULE', kind: 'mandatory', appliesTo: 'clinical', clauseKey: 'provenance_rule',
    rationale: 'CPIC guideline name and version, rule pack version, date of issue.' },
  { ruleCode: 'MUST_INDIA_TIER', kind: 'mandatory', appliesTo: 'clinical', clauseKey: 'india_evidence_tier',
    rationale: 'India Evidence Tier, printed, with its one-line definition. A clinician reading IN-2 knows what they are holding.' },
  { ruleCode: 'MUST_SIGNATORY', kind: 'mandatory', appliesTo: 'both', clauseKey: 'signatory',
    rationale: 'Clinician name and registration number. No unsigned clinical output leaves the system.' },
  { ruleCode: 'MUST_NON_DETERMINISM', kind: 'mandatory', appliesTo: 'both', clauseKey: 'non_determinism',
    rationale: 'Carrying this variant does not mean this person will experience a severe reaction.' },
  { ruleCode: 'MUST_ALTERNATIVES_CAUTION', kind: 'mandatory', appliesTo: 'clinical', clauseKey: 'alternatives_caution',
    rationale: 'Some alternatives carry their own signal in carriers. Drug selection remains the prescribing clinician’s decision.' },
  { ruleCode: 'MUST_FAMILIAL_PROBABILITY', kind: 'mandatory', appliesTo: 'both', clauseKey: 'familial_probability',
    rationale: 'Each first-degree relative has approximately a 50% chance of carrying this variant. A probability, not a diagnosis.' },
  { ruleCode: 'MUST_RIGHT_NOT_TO_KNOW', kind: 'mandatory', appliesTo: 'both', clauseKey: 'right_not_to_know',
    rationale: 'Relatives are under no obligation to be tested and may decline to receive this information.' },
  { ruleCode: 'MUST_FINANCIAL_INTERESTS', kind: 'mandatory', appliesTo: 'clinical', clauseKey: 'financial_interests',
    rationale: 'Declare all financial interests on the advisory document itself.' },
  { ruleCode: 'MUST_LIMITS', kind: 'mandatory', appliesTo: 'clinical', clauseKey: 'limits',
    rationale: 'State the limits of the result before a reader has to ask.' },

  // ---- mandatory clauses: patient companion sheet --------------------
  { ruleCode: 'MUST_PATIENT_WHAT_THIS_IS', kind: 'mandatory', appliesTo: 'patient', clauseKey: 'what_this_is',
    rationale: 'Plain language explanation at a reading level appropriate for a general outpatient population.' },
  { ruleCode: 'MUST_PATIENT_WHAT_TO_DO', kind: 'mandatory', appliesTo: 'patient', clauseKey: 'what_to_do',
    rationale: 'A patient sheet that does not say what to do is decoration.' },
  { ruleCode: 'MUST_PATIENT_SHARING_IS_YOURS', kind: 'mandatory', appliesTo: 'patient', clauseKey: 'sharing_is_your_choice',
    rationale: 'The index patient decides whether to share. The system never contacts relatives.' },
];
