/**
 * Test fixtures.
 *
 * Every fixture starts from a case that SHOULD succeed, and each test
 * breaks exactly one thing. That is the only way to be sure a block is
 * caused by what the test claims and not by an unrelated missing field.
 */
import { RULE_PACK } from '../db/seed/rule-pack-2026.03.1.ts';
import { computeRulePackHash } from '../src/knowledge/hash.ts';
import type {
  AdrEventInput, ConsentState, EvaluationInput, GenotypeResultInput, RulePack,
} from '../src/engine/types.ts';

export const NOW = new Date('2026-10-01T09:00:00.000Z');

/** A pack that is valid, active, unexpired and whose hash is correct. */
export function makePack(overrides: Partial<RulePack> = {}): RulePack {
  const base: RulePack = {
    ...structuredClone(RULE_PACK),
    // Fixtures use a curated pack so that the demonstration-pack block is
    // tested on purpose rather than tripping every other test.
    provenanceStatus: 'curated_verified',
    effectiveFrom: '2026-09-01T00:00:00.000Z',
    expiresAt: '2027-02-28T00:00:00.000Z',
    isActive: true,
    ...overrides,
  };
  base.contentHash = computeRulePackHash(base as unknown as Record<string, unknown>);
  return base;
}

export function adrEvent(overrides: Partial<AdrEventInput> = {}): AdrEventInput {
  return {
    suspectDrug: 'carbamazepine',
    reactionType: 'SJS',
    causalityWhoUmc: 'probable',
    onsetDate: '2026-08-15',
    latencyDays: 21,
    vigiflowRef: 'IN-DEMO-0001',
    ...overrides,
  };
}

export function genotypePositive(
  overrides: Partial<GenotypeResultInput> = {},
): GenotypeResultInput {
  return {
    geneSymbol: 'HLA-B',
    diplotype: '*15:02/*40:06',
    method: 'PCR-SSP',
    labName: 'Demo Genomics Laboratory',
    labAccreditation: 'NABL',
    reportRef: 'LAB-DEMO-77421',
    resultedAt: '2026-09-20T10:00:00.000Z',
    verified: true,
    ...overrides,
  };
}

export function genotypeNegative(
  overrides: Partial<GenotypeResultInput> = {},
): GenotypeResultInput {
  return genotypePositive({ diplotype: '*40:06/*44:03', ...overrides });
}

export function consents(overrides: Partial<ConsentState> = {}): ConsentState {
  return {
    genotyping: true,
    advisory_issue: true,
    counselling: true,
    registry_deidentified: true,
    recontact: false,
    ...overrides,
  };
}

/** The complete happy path. Break one field per test. */
export function happyPath(overrides: Partial<EvaluationInput> = {}): EvaluationInput {
  return {
    now: NOW,
    rulePack: makePack(),
    adrEvent: adrEvent(),
    consents: consents(),
    genotypeResult: genotypePositive(),
    ...overrides,
  };
}
