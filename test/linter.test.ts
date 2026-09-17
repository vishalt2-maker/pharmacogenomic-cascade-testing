/**
 * SAFETY WORDING LINTER TESTS.
 *
 * The specification's acceptance criterion is blunt: "The linter should
 * refuse to render a document containing the word 'cleared'." That test is
 * here, and so is its harder sibling -- the linter must NOT refuse a
 * document containing a banned phrase inside its mandatory negation.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { lint, lintOrRefuse, RenderRefused, type DocumentBlock } from '../src/render/linter.ts';
import { WORDING_RULES } from '../db/seed/wording-rules.ts';
import { renderAdvisory, toPlainText } from '../src/render/advisory.ts';
import { evaluate } from '../src/engine/engine.ts';
import { happyPath, makePack, genotypeNegative, NOW } from './fixtures.ts';

const RULES = WORDING_RULES;

function doc(body: string, key = 'recommendation'): DocumentBlock[] {
  return [{ key, heading: 'Test', body }];
}

/** The complete set of mandatory clauses, so banned-word tests run clean. */
function withMandatory(extra: DocumentBlock[], profile: 'clinical' | 'patient'): DocumentBlock[] {
  const filler = 'This clause carries enough text to satisfy the minimum length requirement.';
  const keys = RULES
    .filter((r) => r.kind === 'mandatory' && (r.appliesTo === 'both' || r.appliesTo === profile))
    .map((r) => r.clauseKey!);
  return [...keys.map((k) => ({ key: k, body: filler })), ...extra];
}

describe('banned constructions', () => {
  test('THE ACCEPTANCE TEST: a document containing "cleared" is refused', () => {
    const blocks = withMandatory(
      doc('This patient is cleared for carbamazepine.'), 'clinical');
    assert.throws(
      () => lintOrRefuse(blocks, RULES, 'clinical'),
      (err: unknown) => {
        assert.ok(err instanceof RenderRefused);
        assert.ok(err.violations.some((v) => v.ruleCode === 'BAN_CLEARED'));
        return true;
      });
  });

  test('"clearance" is refused too', () => {
    assert.equal(lint(doc('Genetic clearance granted.'), RULES, 'clinical')
      .filter((v) => v.ruleCode === 'BAN_CLEARED').length, 1);
  });

  const banned: Array<[string, string]> = [
    ['This drug is safe for the patient.', 'BAN_SAFE'],
    ['There is no risk to this individual.', 'BAN_NO_RISK'],
    ['This eliminates the risk entirely.', 'BAN_NO_RISK'],
    ['We guarantee no reaction will occur.', 'BAN_GUARANTEE'],
    ['The patient will develop a severe reaction.', 'BAN_WILL_DEVELOP'],
    ['She will experience Stevens-Johnson Syndrome.', 'BAN_WILL_DEVELOP'],
    ['Carry this danger card at all times.', 'BAN_DANGER_CARD'],
    ['The patient has a genetic defect.', 'BAN_GENETIC_DEFECT'],
    ['Use our recommended laboratory for testing.', 'BAN_REFERRAL_STEERING'],
    ['Book here for your family test.', 'BAN_REFERRAL_STEERING'],
    ['See https://labs.example.com/test?utm_source=advisory', 'BAN_TRACKED_LINK'],
    ['The system recommends avoiding carbamazepine.', 'BAN_SYSTEM_RECOMMENDS'],
    ['The algorithm decides which drug to use.', 'BAN_SYSTEM_RECOMMENDS'],
    ['The tool diagnoses the condition.', 'BAN_DIAGNOSES'],
  ];
  for (const [text, code] of banned) {
    test(`refuses: ${text}`, () => {
      const v = lint(doc(text), RULES, 'clinical');
      assert.ok(v.some((x) => x.ruleCode === code),
        `expected ${code}, got ${JSON.stringify(v.map((x) => x.ruleCode))}`);
    });
  }

  test('a violation reports what matched and why, not just that it failed', () => {
    const v = lint(doc('This patient is cleared.'), RULES, 'clinical')
      .find((x) => x.ruleCode === 'BAN_CLEARED')!;
    assert.equal(v.matched, 'cleared');
    assert.equal(v.blockKey, 'recommendation');
    assert.match(v.rationale, /eliminated risk/i);
    assert.match(v.context ?? '', /cleared/);
  });
});

describe('negation exemptions -- the mandatory clauses must survive linting', () => {
  const allowed = [
    'Carrying this variant does not mean this person will experience a severe reaction.',
    'A negative result does not eliminate the risk of a severe cutaneous reaction.',
    'This result does not mean the drug is safe for everyone.',
    'A negative result is not a clearance and carries no guarantee of absence of risk.',
  ];
  for (const text of allowed) {
    test(`allows the negated form: "${text.slice(0, 48)}..."`, () => {
      const v = lint(doc(text), RULES, 'clinical')
        .filter((x) => ['BAN_WILL_DEVELOP', 'BAN_NO_RISK', 'BAN_SAFE'].includes(x.ruleCode));
      assert.deepEqual(v.map((x) => x.ruleCode), [],
        'a negation must not be linted as an assertion');
    });
  }

  test('but "cleared" has no exemption, even negated', () => {
    // There is no safe way to print the word. It is banned outright.
    const v = lint(doc('This is not a clearance.'), RULES, 'clinical');
    assert.ok(v.some((x) => x.ruleCode === 'BAN_CLEARED'));
  });
});

describe('profiles -- the two documents have different registers', () => {
  test('"mutation" is banned for the patient and permitted for the clinician', () => {
    const text = doc('The patient carries a mutation in HLA-B.');
    assert.ok(lint(text, RULES, 'patient').some((v) => v.ruleCode === 'BAN_MUTATION'));
    assert.ok(!lint(text, RULES, 'clinical').some((v) => v.ruleCode === 'BAN_MUTATION'));
  });

  test('"abnormal" is banned in the patient sheet', () => {
    assert.ok(lint(doc('This is an abnormal result.'), RULES, 'patient')
      .some((v) => v.ruleCode === 'BAN_ABNORMAL'));
  });
});

describe('claims about people who have not been tested', () => {
  test('calling an untested sibling a confirmed carrier is refused', () => {
    assert.ok(
      lint(doc('Each sibling is a confirmed carrier of this variant.'), RULES, 'clinical')
        .some((v) => v.ruleCode === 'BAN_CONFIRMED_CARRIER_RELATIVE'));
  });

  test('describing the index patient as a confirmed carrier is fine', () => {
    assert.ok(
      !lint(doc('This individual is a confirmed carrier, established by laboratory testing.'),
        RULES, 'clinical')
        .some((v) => v.ruleCode === 'BAN_CONFIRMED_CARRIER_RELATIVE'));
  });

  test('stating the 50% probability for relatives is fine', () => {
    const banned = lint(
      doc('Each first-degree relative has approximately a 50 per cent probability of carrying this variant.'),
      RULES, 'clinical').filter((v) => v.kind === 'banned');
    assert.deepEqual(banned.map((v) => v.ruleCode), []);
  });
});

describe('mandatory clauses', () => {
  test('a missing mandatory clause is refused', () => {
    const v = lint([{ key: 'finding', body: 'Something' }], RULES, 'clinical');
    const codes = v.map((x) => x.ruleCode);
    for (const required of ['MUST_ADDRESSEE', 'MUST_SIGNATORY', 'MUST_RIGHT_NOT_TO_KNOW',
      'MUST_FAMILIAL_PROBABILITY', 'MUST_NON_DETERMINISM', 'MUST_INDIA_TIER']) {
      assert.ok(codes.includes(required), `${required} should have been raised`);
    }
  });

  test('a present-but-token clause is refused: a checklist protects nobody', () => {
    const blocks = withMandatory([], 'clinical')
      .map((b) => b.key === 'right_not_to_know' ? { ...b, body: 'Yes.' } : b);
    assert.ok(lint(blocks, RULES, 'clinical')
      .some((v) => v.ruleCode === 'MUST_RIGHT_NOT_TO_KNOW'));
  });

  test('an unparseable rule is reported, never silently skipped', () => {
    const broken = [{
      ruleCode: 'BAN_BROKEN', kind: 'banned' as const, appliesTo: 'both' as const,
      pattern: '([unclosed', rationale: 'deliberately invalid',
    }];
    const v = lint(doc('anything'), broken, 'clinical');
    assert.equal(v.length, 1);
    assert.equal(v[0].ruleCode, 'BAN_BROKEN');
  });
});

describe('the real rendered advisory passes its own linter', () => {
  const evaluation = evaluate(happyPath());
  const base = {
    evaluation,
    rulePack: makePack(),
    signatory: { fullName: 'Dr A. Narayanan', registrationNo: 'NMC-DEMO-10001', registrationBody: 'NMC' },
    issuedOn: NOW,
    organisationName: 'Demo Teaching Hospital AMC (Pune)',
    labName: 'Demo Genomics Laboratory', labAccreditation: 'NABL',
    method: 'PCR-SSP', reportRef: 'LAB-DEMO-77421',
    resultedAt: '2026-09-20T10:00:00.000Z',
  };

  test('renders both documents without a single violation', () => {
    const out = renderAdvisory(base);
    assert.equal(out.clinical.profile, 'clinical');
    assert.equal(out.patient.profile, 'patient');
    assert.equal(lint(out.clinical.blocks, RULES, 'clinical').length, 0);
    assert.equal(lint(out.patient.blocks, RULES, 'patient').length, 0);
  });

  test('the clinical document carries every mandatory clause', () => {
    const keys = new Set(renderAdvisory(base).clinical.blocks.map((b) => b.key));
    for (const k of ['addressee', 'provenance_genotype', 'provenance_rule',
      'india_evidence_tier', 'signatory', 'non_determinism', 'alternatives_caution',
      'familial_probability', 'right_not_to_know', 'financial_interests', 'limits']) {
      assert.ok(keys.has(k), `missing mandatory clause: ${k}`);
    }
  });

  test('the India Evidence Tier is printed with its definition', () => {
    const text = toPlainText(renderAdvisory(base).clinical);
    assert.match(text, /India Evidence Tier: IN-2/);
    assert.match(text, /Small Indian case series or case-control data/);
    assert.match(text, /not a level of evidence/i);
  });

  test('the alternatives carry their own cautions, named', () => {
    const text = toPlainText(renderAdvisory(base).clinical);
    assert.match(text, /oxcarbazepine:/);
    assert.match(text, /prescribing clinician’s decision/);
  });

  test('the patient sheet carries no star alleles and no phenotype jargon', () => {
    const text = toPlainText(renderAdvisory(base).patient);
    assert.ok(!/\*15:02/.test(text), 'star allele leaked into the patient sheet');
    assert.ok(!/diplotype|phenotype|heterozyg/i.test(text), 'jargon leaked into the patient sheet');
    assert.ok(!/HLA-B/.test(text.replace(/Medicines to avoid[\s\S]*/, '')));
  });

  test('the patient sheet renders in Hindi when requested, keeping drug names legible', () => {
    const out = renderAdvisory({ ...base, preferredLanguage: 'hi' });
    assert.equal(out.patient.language, 'hi');
    const text = toPlainText(out.patient);
    assert.match(text, /[ऀ-ॿ]/, 'expected Devanagari');
    // A patient must be able to match the name against a strip of tablets.
    assert.match(text, /carbamazepine/);
  });

  test('an unsupported language falls back to English rather than rendering nothing', () => {
    assert.equal(renderAdvisory({ ...base, preferredLanguage: 'ta' }).patient.language, 'en');
  });

  test('the banner itself must survive the linter it is printed beside', () => {
    // An early draft of the banner said "not regulatory-cleared" and the
    // linter refused the whole document. The rule was right.
    const out = renderAdvisory({ ...base, rulePack: makePack({ provenanceStatus: 'demonstration' }) });
    assert.ok(!/\bcleared\b/i.test(out.banner ?? ''));
  });

  test('a demonstration rule pack stamps a banner on both documents', () => {
    const out = renderAdvisory({ ...base, rulePack: makePack({ provenanceStatus: 'demonstration' }) });
    assert.match(out.banner ?? '', /CONCEPT BUILD/);
    assert.equal(out.clinical.blocks[0].key, 'banner');
    assert.equal(out.patient.blocks[0].key, 'banner');
  });

  test('a verified pack carries no banner', () => {
    assert.equal(renderAdvisory(base).banner, null);
  });

  test('the content hash is stable across renders and changes with content', () => {
    const a = renderAdvisory(base).contentHash;
    const b = renderAdvisory(base).contentHash;
    assert.equal(a, b, 'the same inputs must reproduce the same document, forever');
    const c = renderAdvisory({ ...base, reportRef: 'LAB-DEMO-OTHER' }).contentHash;
    assert.notEqual(a, c);
  });

  test('the renderer refuses an evaluation that produced no finding', () => {
    const negative = evaluate(happyPath({ genotypeResult: genotypeNegative() }));
    assert.equal(negative.finding, null);
    assert.throws(() => renderAdvisory({ ...base, evaluation: negative }), /RENDER_REFUSED/);
  });

  test('the phenytoin advisory states ITS OWN negative caution, not carbamazepine’s', () => {
    const pht = evaluate(happyPath({
      adrEvent: { suspectDrug: 'phenytoin', reactionType: 'TEN', causalityWhoUmc: 'certain' },
    }));
    const text = toPlainText(renderAdvisory({ ...base, evaluation: pht }).clinical);
    // CPIC's position on a negative result differs between the two drugs.
    assert.match(text, /does not eliminate the risk of phenytoin-induced/);
  });
});
