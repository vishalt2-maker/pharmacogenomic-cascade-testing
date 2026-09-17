/**
 * WORDING HYGIENE.
 *
 * The linter guards rendered documents. It does not guard the reason-code
 * messages, the decision-support cards, or the interface copy -- and those
 * are read by exactly the same clinician, in the same session, about the
 * same patient.
 *
 * A rule the project breaks in its own strings is a rule the project does
 * not actually believe. This test applies the document rules to everything
 * else the system says out loud.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { lint } from '../src/render/linter.ts';
import { WORDING_RULES } from '../db/seed/wording-rules.ts';
import { REASON_CODES } from '../src/engine/reason-codes.ts';
import { FIGURES } from '../db/seed/context-figures.ts';
import { INDIA_TIER_DEFINITIONS } from '../src/engine/types.ts';
import { RULE_PACK } from '../db/seed/rule-pack-2026.03.1.ts';
import { PROJECT_ROOT } from '../src/db/client.ts';

/** Only the banned constructions apply; mandatory clauses are a document concept. */
function bannedIn(text: string, profile: 'clinical' | 'patient' = 'clinical') {
  return lint([{ key: 'text', body: text }], WORDING_RULES, profile)
    .filter((v) => v.kind === 'banned');
}

describe('the system’s own strings obey the rules it enforces on documents', () => {
  test('no reason-code message or remedy uses a banned construction', () => {
    for (const r of REASON_CODES) {
      for (const [field, text] of [['message', r.message], ['remedy', r.remedy ?? '']]) {
        const v = bannedIn(text);
        assert.deepEqual(v.map((x) => x.ruleCode), [],
          `${r.code}.${field}: ${JSON.stringify(text)} — ${v.map((x) => x.ruleCode).join(', ')}`);
      }
    }
  });

  test('no India Evidence Tier definition uses a banned construction', () => {
    for (const [tier, def] of Object.entries(INDIA_TIER_DEFINITIONS)) {
      assert.deepEqual(bannedIn(def).map((x) => x.ruleCode), [], `${tier}: ${def}`);
    }
  });

  test('no verified figure, caveat or source uses a banned construction', () => {
    for (const f of FIGURES) {
      for (const text of [f.label, f.value, f.caveat ?? '']) {
        assert.deepEqual(bannedIn(text).map((x) => x.ruleCode), [],
          `${f.key}: ${JSON.stringify(text)}`);
      }
    }
  });

  test('no rule pack recommendation or caution uses a banned construction', () => {
    for (const rec of RULE_PACK.recommendations) {
      for (const text of [rec.clinicalText, rec.implicationsText ?? '']) {
        assert.deepEqual(bannedIn(text).map((x) => x.ruleCode), [],
          `${rec.id}: ${JSON.stringify(text.slice(0, 90))}`);
      }
      for (const alt of rec.alternatives) {
        assert.deepEqual(bannedIn(alt.cautionText ?? '').map((x) => x.ruleCode), [],
          `${rec.id} / ${alt.drugName}`);
      }
    }
    for (const pair of RULE_PACK.pairs) {
      assert.deepEqual(bannedIn(pair.negativeResultCaution).map((x) => x.ruleCode), [],
        `${pair.id} negative caution`);
    }
  });

  test('the operator interface copy uses no banned construction', () => {
    const html = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'ui', 'index.html'), 'utf8');
    // Strip tags and decode the handful of entities the page actually uses.
    const visible = html
      .replace(/<script[\s\S]*?<\/script>/g, ' ')
      .replace(/<style[\s\S]*?<\/style>/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[lr]dquo;/g, '"').replace(/&hellip;/g, '...')
      .replace(/&middot;/g, '.').replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ');
    const v = bannedIn(visible);
    assert.deepEqual(v.map((x) => `${x.ruleCode}:${x.matched}`), []);
  });

  test('every reason code has a message a clinician could act on', () => {
    for (const r of REASON_CODES) {
      assert.ok(r.message.length > 20, `${r.code} message is too short to be useful`);
      assert.ok(/[.!]$/.test(r.message.trim()), `${r.code} message is not a sentence`);
      if (r.severity === 'block') {
        // A block with no explanation of what to do next is a dead end.
        assert.ok(r.remedy || /^(RULE_PACK_NOT_YET_EFFECTIVE|CONSENT_WITHDRAWN|GENOTYPE_GENE_MISMATCH|GENOTYPE_RESULT_EXPIRED|RECOMMENDATION_MISSING|ALTERNATIVE_CAUTION_MISSING|ADR_EVENT_MISSING|ADR_DRUG_MISSING|REACTION_MISSING|RULE_PACK_INACTIVE)$/.test(r.code),
          `${r.code} blocks with no remedy and no reason to lack one`);
      }
    }
  });

  test('the ban on "cleared" has no exemption, deliberately', () => {
    const rule = WORDING_RULES.find((r) => r.ruleCode === 'BAN_CLEARED')!;
    assert.equal(rule.exemptIfPrecededBy, undefined,
      'there is no safe way to print that word, including negated');
  });
});
