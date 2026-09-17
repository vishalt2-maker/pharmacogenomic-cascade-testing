/**
 * THE SAFETY WORDING LINTER.
 *
 * Section 6 of the specification is built as VALIDATION, not as guidance:
 * a linter that refuses to render a document containing a banned
 * construction. Guidance is advice that a tired person at 2am can skip.
 * Validation is not.
 *
 * Two profiles, because the two documents have genuinely different
 * registers. "Mutation" is acceptable in a clinical advisory addressed to a
 * prescriber and banned in a patient companion sheet, where it induces
 * genetic fatalism. Never make the patient read the clinical document;
 * never let the clinical document be simplified into vagueness.
 */
import type { WordingRule } from '../engine/types.ts';

export type DocumentProfile = 'clinical' | 'patient';

export interface DocumentBlock {
  /** Stable key. Mandatory clauses are checked against these. */
  key: string;
  heading?: string;
  body: string | string[];
}

export interface Violation {
  ruleCode: string;
  kind: 'banned' | 'mandatory';
  blockKey: string | null;
  matched?: string;
  context?: string;
  rationale: string;
}

export class RenderRefused extends Error {
  violations: Violation[];
  profile: DocumentProfile;
  constructor(profile: DocumentProfile, violations: Violation[]) {
    super(
      `RENDER_REFUSED: the ${profile} document violates ${violations.length} ` +
      `safety wording rule${violations.length === 1 ? '' : 's'}: ` +
      violations.map((v) => v.ruleCode).join(', '));
    this.name = 'RenderRefused';
    this.violations = violations;
    this.profile = profile;
  }
}

function blockText(b: DocumentBlock): string {
  const body = Array.isArray(b.body) ? b.body.join('\n') : b.body;
  return [b.heading ?? '', body].join('\n');
}

function appliesToProfile(rule: WordingRule, profile: DocumentProfile): boolean {
  return rule.appliesTo === 'both' || rule.appliesTo === profile;
}

/** How much preceding text an exemption may look back over. */
const LOOKBACK = 90;

export function lint(
  blocks: DocumentBlock[],
  rules: WordingRule[],
  profile: DocumentProfile,
): Violation[] {
  const violations: Violation[] = [];

  // ---- banned constructions ----------------------------------------
  for (const rule of rules) {
    if (rule.kind !== 'banned' || !rule.pattern) continue;
    if (!appliesToProfile(rule, profile)) continue;

    let re: RegExp;
    try {
      re = new RegExp(rule.pattern, 'gi');
    } catch {
      // An unparseable rule is itself a failure. A linter that silently
      // skips a rule it cannot compile is worse than no linter, because it
      // reports success.
      violations.push({
        ruleCode: rule.ruleCode, kind: 'banned', blockKey: null,
        rationale: `The wording rule ${rule.ruleCode} has an invalid pattern and could not be applied.`,
      });
      continue;
    }

    const exempt = rule.exemptIfPrecededBy
      ? new RegExp(rule.exemptIfPrecededBy, 'i')
      : null;

    for (const block of blocks) {
      const text = blockText(block);
      for (const m of text.matchAll(re)) {
        const at = m.index ?? 0;
        const before = text.slice(Math.max(0, at - LOOKBACK), at);
        // A banned construction is usually only banned when ASSERTED. The
        // mandatory non-determinism clause must be able to say "does not
        // mean this person will experience a severe reaction".
        if (exempt && exempt.test(before)) continue;
        violations.push({
          ruleCode: rule.ruleCode,
          kind: 'banned',
          blockKey: block.key,
          matched: m[0],
          context: text
            .slice(Math.max(0, at - 50), Math.min(text.length, at + m[0].length + 50))
            .replace(/\s+/g, ' ')
            .trim(),
          rationale: rule.rationale,
        });
      }
    }
  }

  // ---- mandatory clauses -------------------------------------------
  const present = new Map(blocks.map((b) => [b.key, blockText(b).trim()]));
  for (const rule of rules) {
    if (rule.kind !== 'mandatory' || !rule.clauseKey) continue;
    if (!appliesToProfile(rule, profile)) continue;
    const body = present.get(rule.clauseKey);
    if (body === undefined) {
      violations.push({
        ruleCode: rule.ruleCode, kind: 'mandatory', blockKey: rule.clauseKey,
        rationale: `Mandatory clause "${rule.clauseKey}" is absent. ${rule.rationale}`,
      });
    } else if (body.length < 25) {
      // An empty or token clause satisfies a checklist and protects nobody.
      violations.push({
        ruleCode: rule.ruleCode, kind: 'mandatory', blockKey: rule.clauseKey,
        rationale: `Mandatory clause "${rule.clauseKey}" is present but effectively empty. ${rule.rationale}`,
      });
    }
  }

  return violations;
}

/** Lint, and refuse to proceed if anything failed. */
export function lintOrRefuse(
  blocks: DocumentBlock[], rules: WordingRule[], profile: DocumentProfile,
): void {
  const v = lint(blocks, rules, profile);
  if (v.length > 0) throw new RenderRefused(profile, v);
}

/** Human-readable report, used by the CLI and the API error response. */
export function formatViolations(violations: Violation[]): string {
  return violations.map((v) => {
    const where = v.blockKey ? ` [${v.blockKey}]` : '';
    const what = v.matched ? ` matched "${v.matched}"` : '';
    const ctx = v.context ? `\n      ...${v.context}...` : '';
    return `  ${v.ruleCode}${where}${what}\n      ${v.rationale}${ctx}`;
  }).join('\n');
}
