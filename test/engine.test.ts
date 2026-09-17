/**
 * SAFETY ENGINE TESTS.
 *
 * "Test the blocks harder than the passes." This file is weighted
 * accordingly: the system's primary skill is refusing to act, so most of
 * what follows asserts that it refuses, and names the right reason.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, ENGINE_VERSION } from '../src/engine/engine.ts';
import { ALL_CODES, reason } from '../src/engine/reason-codes.ts';
import {
  NOW, adrEvent, consents, genotypeNegative, genotypePositive, happyPath, makePack,
} from './fixtures.ts';

/** Assert a decision and that a specific reason code was given. */
function expectBlock(input: Parameters<typeof evaluate>[0], code: string) {
  const r = evaluate(input);
  assert.equal(r.decision, 'BLOCK', `expected BLOCK, got ${r.decision} (${r.reasonCodes})`);
  assert.ok(r.reasonCodes.includes(code),
    `expected reason ${code}, got ${JSON.stringify(r.reasonCodes)}`);
  return r;
}
function expectNoAction(input: Parameters<typeof evaluate>[0], code: string) {
  const r = evaluate(input);
  assert.equal(r.decision, 'NO_ACTION', `expected NO_ACTION, got ${r.decision} (${r.reasonCodes})`);
  assert.ok(r.reasonCodes.includes(code),
    `expected reason ${code}, got ${JSON.stringify(r.reasonCodes)}`);
  return r;
}

describe('the happy path, so that every block below means something', () => {
  test('a complete, confirmed, consented, genotyped case produces a DRAFT', () => {
    const r = evaluate(happyPath());
    assert.equal(r.decision, 'ADVISORY_DRAFT');
    assert.deepEqual(r.reasonCodes, []);
    assert.equal(r.finding?.pair.geneSymbol, 'HLA-B');
    assert.equal(r.finding?.recommendation.actionCode, 'avoid_drug');
    assert.equal(r.indiaEvidenceTier, 'IN-2');
  });

  test('the best possible output is a DRAFT, never an issued advisory', () => {
    // G8 is outside the engine. Nothing prints until a named clinician signs.
    const decisions = new Set<string>();
    for (const drug of ['carbamazepine', 'phenytoin']) {
      decisions.add(evaluate(happyPath({ adrEvent: adrEvent({ suspectDrug: drug }) })).decision);
    }
    assert.deepEqual([...decisions], ['ADVISORY_DRAFT']);
  });

  test('sign-off is recorded as a skipped gate, not silently omitted', () => {
    const r = evaluate(happyPath());
    const g8 = r.gateTrace.find((g) => g.gate === 'G8');
    assert.ok(g8, 'G8 must appear in the trace');
    assert.equal(g8?.status, 'skipped');
  });

  test('the engine is pure: same input, same output, including the trace', () => {
    const a = evaluate(happyPath());
    const b = evaluate(happyPath());
    assert.deepEqual(a, b);
  });

  test('phenytoin resolves to its own pair and its own guideline', () => {
    const r = evaluate(happyPath({ adrEvent: adrEvent({ suspectDrug: 'phenytoin' }) }));
    assert.equal(r.decision, 'ADVISORY_DRAFT');
    assert.equal(r.finding?.pair.id, 'pair-hlab-pht');
    assert.match(r.finding!.pair.guidelineCitation, /Phenytoin Dosing/i);
  });

  test('a brand name resolves through synonyms, and the trace says so', () => {
    const r = evaluate(happyPath({ adrEvent: adrEvent({ suspectDrug: '  TEGRETOL ' }) }));
    assert.equal(r.decision, 'ADVISORY_DRAFT');
    const g1 = r.gateTrace.find((g) => g.gate === 'G1');
    assert.equal(g1?.detail.matchedOn, 'synonym');
    assert.equal(g1?.detail.resolvedDrug, 'carbamazepine');
  });
});

describe('G0 rule pack', () => {
  test('no pack at all blocks', () => {
    expectBlock(happyPath({ rulePack: null }), 'RULE_PACK_MISSING');
  });

  test('an inactive pack blocks', () => {
    expectBlock(happyPath({ rulePack: makePack({ isActive: false }) }), 'RULE_PACK_INACTIVE');
  });

  test('AN EXPIRED PACK BLOCKS -- expiry is enforced, not advisory', () => {
    const pack = makePack({ expiresAt: '2026-09-30T00:00:00.000Z' });
    expectBlock(happyPath({ rulePack: pack }), 'RULE_PACK_STALE');
  });

  test('a pack expiring in one second still blocks one second later', () => {
    const pack = makePack({ expiresAt: NOW.toISOString() });
    expectBlock(happyPath({ rulePack: pack }), 'RULE_PACK_STALE');
  });

  test('a pack that is not yet effective blocks', () => {
    const pack = makePack({
      effectiveFrom: '2026-12-01T00:00:00.000Z', expiresAt: '2027-06-01T00:00:00.000Z',
    });
    expectBlock(happyPath({ rulePack: pack }), 'RULE_PACK_NOT_YET_EFFECTIVE');
  });

  test('a tampered pack blocks: the hash is recomputed, never trusted', () => {
    const pack = makePack();
    // Flip the recommendation from avoid to standard dosing without
    // restamping the hash -- exactly what a malicious or careless edit
    // to the knowledge layer would look like.
    pack.recommendations[0].actionCode = 'standard_dose';
    expectBlock(happyPath({ rulePack: pack }), 'RULE_PACK_INVALID');
  });

  test('a demonstration pack blocks unless a deployment opts in', () => {
    const pack = makePack({ provenanceStatus: 'demonstration' });
    expectBlock(happyPath({ rulePack: pack }), 'RULE_PACK_NOT_CLINICALLY_CURATED');

    const r = evaluate(happyPath({
      rulePack: pack, policy: { allowDemonstrationPack: true },
    }));
    assert.equal(r.decision, 'ADVISORY_DRAFT');
    assert.ok(r.warnings.includes('RULE_PACK_CITATIONS_UNVERIFIED'));
  });

  test('a pack nearing expiry warns without blocking', () => {
    const pack = makePack({ expiresAt: '2026-10-20T00:00:00.000Z' });
    const r = evaluate(happyPath({ rulePack: pack }));
    assert.equal(r.decision, 'ADVISORY_DRAFT');
    assert.ok(r.warnings.includes('RULE_PACK_EXPIRING_SOON'));
  });

  test('an unparseable date blocks rather than being treated as no expiry', () => {
    const pack = makePack();
    (pack as { expiresAt: string }).expiresAt = 'whenever';
    expectBlock(happyPath({ rulePack: pack }), 'RULE_PACK_INVALID');
  });
});

describe('G1 drug in scope', () => {
  test('a missing ADR event blocks', () => {
    expectBlock(happyPath({ adrEvent: null }), 'ADR_EVENT_MISSING');
  });

  test('a NULL drug name blocks -- null is failure, not absence of objection', () => {
    expectBlock(happyPath({ adrEvent: adrEvent({ suspectDrug: null }) }), 'ADR_DRUG_MISSING');
  });

  test('an empty drug name blocks', () => {
    expectBlock(happyPath({ adrEvent: adrEvent({ suspectDrug: '   ' }) }), 'ADR_DRUG_MISSING');
  });

  test('a drug outside the pack produces NO_ACTION, not a block', () => {
    // Out of scope is not an error. It is simply none of our business.
    expectNoAction(happyPath({ adrEvent: adrEvent({ suspectDrug: 'amoxicillin' }) }),
      'DRUG_OUT_OF_SCOPE');
  });

  test('a drug in the pack but not in cascade scope produces NO_ACTION', () => {
    // Levetiracetam is in the pack as an alternative, not as a cascade pair.
    expectNoAction(happyPath({ adrEvent: adrEvent({ suspectDrug: 'levetiracetam' }) }),
      'DRUG_OUT_OF_SCOPE');
  });

  test('an ambiguous drug name blocks rather than picking one', () => {
    const pack = makePack();
    // Two drugs sharing a synonym: the engine must refuse to choose.
    pack.drugs.push({ name: 'carbamazepine (modified release)', synonyms: ['Tegretol'] });
    pack.contentHash = '';
    const restamped = makePack({ drugs: pack.drugs });
    expectBlock(
      happyPath({ rulePack: restamped, adrEvent: adrEvent({ suspectDrug: 'Tegretol' }) }),
      'DRUG_AMBIGUOUS');
  });
});

describe('G2 reaction in scope', () => {
  test('a missing reaction type blocks', () => {
    expectBlock(happyPath({ adrEvent: adrEvent({ reactionType: null }) }), 'REACTION_MISSING');
  });

  test('a non-cutaneous reaction produces NO_ACTION', () => {
    expectNoAction(happyPath({ adrEvent: adrEvent({ reactionType: 'non_cutaneous' }) }),
      'REACTION_OUT_OF_SCOPE');
  });

  test('AGEP is out of scope in this pack and produces NO_ACTION', () => {
    expectNoAction(happyPath({ adrEvent: adrEvent({ reactionType: 'AGEP' }) }),
      'REACTION_OUT_OF_SCOPE');
  });

  for (const rt of ['SJS', 'TEN', 'SJS_TEN_overlap', 'DRESS', 'MPE'] as const) {
    test(`${rt} is in scope`, () => {
      const r = evaluate(happyPath({ adrEvent: adrEvent({ reactionType: rt }) }));
      assert.equal(r.decision, 'ADVISORY_DRAFT');
    });
  }
});

describe('G3 causality -- cascade starts from a CONFIRMED index case', () => {
  test('not assessed blocks, and says so specifically', () => {
    expectBlock(happyPath({ adrEvent: adrEvent({ causalityWhoUmc: 'not_assessed' }) }),
      'CAUSALITY_NOT_ASSESSED');
  });

  test('a NULL causality blocks as not assessed', () => {
    expectBlock(happyPath({ adrEvent: adrEvent({ causalityWhoUmc: null }) }),
      'CAUSALITY_NOT_ASSESSED');
  });

  for (const c of ['possible', 'unlikely', 'conditional', 'unassessable'] as const) {
    test(`${c} causality blocks as insufficient`, () => {
      expectBlock(happyPath({ adrEvent: adrEvent({ causalityWhoUmc: c }) }),
        'CAUSALITY_INSUFFICIENT');
    });
  }

  for (const c of ['probable', 'certain'] as const) {
    test(`${c} causality passes`, () => {
      assert.equal(evaluate(happyPath({ adrEvent: adrEvent({ causalityWhoUmc: c }) })).decision,
        'ADVISORY_DRAFT');
    });
  }
});

describe('G4 consent -- separate and explicit, never a blanket flag', () => {
  test('no genotyping consent blocks', () => {
    expectBlock(happyPath({ consents: consents({ genotyping: false }) }), 'CONSENT_MISSING');
  });

  test('no advisory consent blocks even when genotyping was consented', () => {
    expectBlock(happyPath({ consents: consents({ advisory_issue: false }) }), 'CONSENT_MISSING');
  });

  test('an empty consent object blocks', () => {
    expectBlock(happyPath({ consents: {} as never }), 'CONSENT_MISSING');
  });

  test('consent for an unrelated purpose does not substitute', () => {
    expectBlock(
      happyPath({ consents: { genotyping: false, advisory_issue: false, counselling: true } }),
      'CONSENT_MISSING');
  });
});

describe('G5 genotype -- THE GATE', () => {
  test('NO GENOTYPE, NO CASCADE. This is the differentiator.', () => {
    const r = expectBlock(happyPath({ genotypeResult: null }), 'GENOTYPE_REQUIRED');
    // Everything before it passed. The refusal is specifically about the
    // missing genotype, not about an incomplete case.
    const upTo = r.gateTrace.filter((g) => ['G0', 'G1', 'G2', 'G3', 'G4'].includes(g.gate));
    assert.equal(upTo.length, 5);
    assert.ok(upTo.every((g) => g.status === 'pass'));
  });

  test('a result with no diplotype blocks', () => {
    expectBlock(happyPath({ genotypeResult: genotypePositive({ diplotype: null }) }),
      'GENOTYPE_REQUIRED');
  });

  test('a result with no laboratory report reference blocks', () => {
    expectBlock(happyPath({ genotypeResult: genotypePositive({ reportRef: '' }) }),
      'GENOTYPE_REQUIRED');
  });

  test('an unaccredited laboratory blocks', () => {
    expectBlock(happyPath({ genotypeResult: genotypePositive({ labAccreditation: 'none' }) }),
      'LAB_NOT_ACCREDITED');
  });

  test('a missing accreditation blocks', () => {
    expectBlock(happyPath({ genotypeResult: genotypePositive({ labAccreditation: null }) }),
      'LAB_NOT_ACCREDITED');
  });

  test('CAP accreditation is accepted alongside NABL', () => {
    assert.equal(
      evaluate(happyPath({ genotypeResult: genotypePositive({ labAccreditation: 'CAP' }) })).decision,
      'ADVISORY_DRAFT');
  });

  test('an unverified result blocks: two people, because transcription kills', () => {
    expectBlock(happyPath({ genotypeResult: genotypePositive({ verified: false }) }),
      'GENOTYPE_UNVERIFIED');
  });

  test('a future-dated result blocks as a data error', () => {
    expectBlock(
      happyPath({ genotypeResult: genotypePositive({ resultedAt: '2027-01-01T00:00:00.000Z' }) }),
      'GENOTYPE_RESULT_DATE_INVALID');
  });

  test('an unparseable result date blocks', () => {
    expectBlock(happyPath({ genotypeResult: genotypePositive({ resultedAt: 'last Tuesday' }) }),
      'GENOTYPE_RESULT_DATE_INVALID');
  });

  test('a gene that does not match the pair blocks', () => {
    expectBlock(happyPath({ genotypeResult: genotypePositive({ geneSymbol: 'CYP2C9' }) }),
      'GENOTYPE_GENE_MISMATCH');
  });

  test('AN UNRECOGNISED DIPLOTYPE BLOCKS. It is never read as absence of risk.', () => {
    const r = expectBlock(
      happyPath({ genotypeResult: genotypePositive({ diplotype: '*15:11/*40:06' }) }),
      'DIPLOTYPE_UNRECOGNISED');
    assert.equal(r.negativePathway, false, 'must NOT be treated as a negative result');
    assert.equal(r.finding, null);
  });

  test('a blank diplotype is not silently read as negative', () => {
    const r = expectBlock(happyPath({ genotypeResult: genotypePositive({ diplotype: '' }) }),
      'GENOTYPE_REQUIRED');
    assert.equal(r.negativePathway, false);
  });

  test('the maximum-age policy blocks an old result when configured', () => {
    expectBlock(
      happyPath({ policy: { genotypeMaxAgeDays: 5 } }), 'GENOTYPE_RESULT_EXPIRED');
  });

  test('by default a germline result does not expire', () => {
    const r = evaluate(happyPath({
      genotypeResult: genotypePositive({ resultedAt: '2015-01-01T00:00:00.000Z' }),
    }));
    assert.equal(r.decision, 'ADVISORY_DRAFT');
  });
});

describe('the negative pathway -- a negative is not a clearance', () => {
  test('a negative index result produces NO document by default', () => {
    const r = evaluate(happyPath({ genotypeResult: genotypeNegative() }));
    assert.equal(r.decision, 'NO_ACTION');
    assert.ok(r.reasonCodes.includes('NEGATIVE_RESULT_NO_ADVISORY'));
    assert.equal(r.negativePathway, true);
    assert.equal(r.finding, null, 'no finding means nothing to render');
  });

  test('a negative result always carries the does-not-exclude-risk warning', () => {
    const r = evaluate(happyPath({ genotypeResult: genotypeNegative() }));
    assert.ok(r.warnings.includes('NEGATIVE_DOES_NOT_EXCLUDE_RISK'));
  });

  test('the monitoring-reminder option informs, and still never clears', () => {
    const r = evaluate(happyPath({
      genotypeResult: genotypeNegative(),
      policy: { negativePathway: 'monitoring_reminder' },
    }));
    assert.equal(r.decision, 'INFORM_ONLY');
    assert.ok(r.reasonCodes.includes('NEGATIVE_MONITORING_REMINDER'));
    assert.ok(r.warnings.includes('NEGATIVE_DOES_NOT_EXCLUDE_RISK'));
  });

  test('the negative pathway skips G6 and G7 rather than passing them', () => {
    const r = evaluate(happyPath({ genotypeResult: genotypeNegative() }));
    for (const g of ['G6', 'G7']) {
      assert.equal(r.gateTrace.find((t) => t.gate === g)?.status, 'skipped');
    }
  });
});

describe('G6 recommendation resolvable', () => {
  test('no recommendation for the pair and phenotype blocks', () => {
    const pack = makePack();
    const trimmed = makePack({
      recommendations: pack.recommendations.filter((r) => r.id !== 'rec-cbz-pos'),
    });
    expectBlock(happyPath({ rulePack: trimmed }), 'RECOMMENDATION_MISSING');
  });

  test('two recommendations block: ambiguity is named, never resolved', () => {
    const pack = makePack();
    const dup = structuredClone(pack.recommendations.find((r) => r.id === 'rec-cbz-pos')!);
    dup.id = 'rec-cbz-pos-duplicate';
    dup.actionCode = 'standard_dose';   // the safer-sounding option
    const conflicted = makePack({ recommendations: [...pack.recommendations, dup] });
    const r = expectBlock(happyPath({ rulePack: conflicted }), 'RECOMMENDATION_AMBIGUOUS');
    assert.equal(r.finding, null);
  });

  test('an alternative flagged as cautionary but with no caution text blocks', () => {
    const pack = makePack();
    const recs = structuredClone(pack.recommendations);
    const rec = recs.find((r) => r.id === 'rec-cbz-pos')!;
    rec.alternatives[0].cautionText = undefined;
    expectBlock(happyPath({ rulePack: makePack({ recommendations: recs }) }),
      'ALTERNATIVE_CAUTION_MISSING');
  });

  test('the alternatives carried through include their cautions', () => {
    const r = evaluate(happyPath());
    const alts = r.finding!.alternatives;
    const oxc = alts.find((a) => a.drugName === 'oxcarbazepine');
    assert.ok(oxc?.cautionFlag, 'oxcarbazepine must carry its own signal');
    assert.ok((oxc?.cautionText ?? '').length > 20);
    assert.ok(alts.some((a) => !a.cautionFlag), 'and some alternatives carry no flag');
  });
});

describe('G7 actionability -- dimension 1, not a level of evidence', () => {
  test('a level C pair informs rather than advising', () => {
    const pack = makePack();
    const pairs = structuredClone(pack.pairs);
    pairs[0].cpicActionability = 'C';
    const r = evaluate(happyPath({ rulePack: makePack({ pairs }) }));
    assert.equal(r.decision, 'INFORM_ONLY');
    assert.ok(r.reasonCodes.includes('BELOW_ACTIONABILITY_THRESHOLD'));
  });

  test('a mixed A/B level does not pass the threshold: fail closed on ambiguity', () => {
    const pack = makePack();
    const pairs = structuredClone(pack.pairs);
    pairs[0].cpicActionability = 'A/B';
    assert.equal(evaluate(happyPath({ rulePack: makePack({ pairs }) })).decision, 'INFORM_ONLY');
  });

  test('"no recommendation" strength informs even at level A', () => {
    const pack = makePack();
    const recs = structuredClone(pack.recommendations);
    recs.find((r) => r.id === 'rec-cbz-pos')!.recommendationStrength = 'no recommendation';
    assert.equal(evaluate(happyPath({ rulePack: makePack({ recommendations: recs }) })).decision,
      'INFORM_ONLY');
  });

  test('a low India Evidence Tier warns but does not block', () => {
    const pack = makePack();
    const pairs = structuredClone(pack.pairs);
    pairs[0].indiaEvidenceTier = 'IN-4';
    const r = evaluate(happyPath({ rulePack: makePack({ pairs }) }));
    assert.equal(r.decision, 'ADVISORY_DRAFT');
    assert.ok(r.warnings.includes('INDIA_EVIDENCE_TIER_LOW'));
    assert.equal(r.indiaEvidenceTier, 'IN-4');
  });

  test('IN-2 does not raise the low-tier warning', () => {
    const r = evaluate(happyPath());
    assert.ok(!r.warnings.includes('INDIA_EVIDENCE_TIER_LOW'));
  });
});

describe('fail-closed invariants', () => {
  test('an unhandled internal error BLOCKS and never degrades to a default', () => {
    const pack = makePack();
    // A getter that throws part-way through gate evaluation.
    Object.defineProperty(pack, 'drugs', {
      get() { throw new TypeError('simulated internal fault'); },
    });
    const r = evaluate(happyPath({ rulePack: pack }));
    assert.equal(r.decision, 'BLOCK');
    assert.deepEqual(r.reasonCodes, ['ENGINE_ERROR']);
    assert.equal(r.finding, null);
  });

  test('a garbage input object blocks rather than throwing at the caller', () => {
    const r = evaluate({ now: NOW } as never);
    assert.equal(r.decision, 'BLOCK');
    assert.ok(r.reasonCodes.length > 0);
  });

  test('an invalid clock blocks', () => {
    const r = evaluate(happyPath({ now: new Date('not a date') }));
    assert.equal(r.decision, 'BLOCK');
  });

  test('NO path through the engine yields ADVISORY_ISSUED', () => {
    const inputs = [
      happyPath(), happyPath({ genotypeResult: null }),
      happyPath({ genotypeResult: genotypeNegative() }),
      happyPath({ rulePack: null }),
    ];
    for (const i of inputs) {
      assert.notEqual(evaluate(i).decision as string, 'ADVISORY_ISSUED');
    }
  });

  test('every evaluation records a gate trace, including the blocks', () => {
    for (const i of [happyPath({ rulePack: null }), happyPath({ genotypeResult: null }),
      happyPath({ adrEvent: adrEvent({ suspectDrug: 'aspirin' }) })]) {
      const r = evaluate(i);
      assert.ok(r.gateTrace.length > 0, 'a block with no trace is unauditable');
      assert.equal(r.engineVersion, ENGINE_VERSION);
    }
  });

  test('every reason code the engine can emit is a documented code', () => {
    const emitted = new Set<string>();
    const cases = [
      happyPath({ rulePack: null }),
      happyPath({ rulePack: makePack({ isActive: false }) }),
      happyPath({ rulePack: makePack({ expiresAt: '2026-01-01T00:00:00.000Z' }) }),
      happyPath({ adrEvent: null }),
      happyPath({ adrEvent: adrEvent({ suspectDrug: null }) }),
      happyPath({ adrEvent: adrEvent({ suspectDrug: 'aspirin' }) }),
      happyPath({ adrEvent: adrEvent({ reactionType: null }) }),
      happyPath({ adrEvent: adrEvent({ reactionType: 'non_cutaneous' }) }),
      happyPath({ adrEvent: adrEvent({ causalityWhoUmc: 'possible' }) }),
      happyPath({ adrEvent: adrEvent({ causalityWhoUmc: 'not_assessed' }) }),
      happyPath({ consents: consents({ genotyping: false }) }),
      happyPath({ genotypeResult: null }),
      happyPath({ genotypeResult: genotypePositive({ labAccreditation: 'x' }) }),
      happyPath({ genotypeResult: genotypePositive({ verified: false }) }),
      happyPath({ genotypeResult: genotypePositive({ diplotype: '*99:99/*40:06' }) }),
      happyPath({ genotypeResult: genotypeNegative() }),
      happyPath(),
    ];
    for (const c of cases) {
      const r = evaluate(c);
      r.reasonCodes.forEach((x) => emitted.add(x));
      r.warnings.forEach((x) => emitted.add(x));
    }
    for (const code of emitted) {
      assert.ok(ALL_CODES.includes(code), `undocumented reason code: ${code}`);
      assert.ok(reason(code).message.length > 10, `${code} has no usable message`);
    }
    assert.ok(emitted.size >= 12, `expected broad coverage, saw ${emitted.size}`);
  });

  test('the engine writes nothing: input objects are not mutated', () => {
    const input = happyPath();
    const before = JSON.stringify(input);
    evaluate(input);
    assert.equal(JSON.stringify(input), before);
  });
});
