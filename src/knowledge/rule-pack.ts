/**
 * Reading rule packs back out for the safety engine.
 *
 * The engine is handed the frozen bundle, and independently recomputes its
 * hash at gate G0. Nothing about the pack is trusted because it came from
 * our own database.
 */
import { asService } from '../db/client.ts';
import { computeRulePackHash } from './hash.ts';
import type { RulePack } from '../engine/types.ts';

export interface PackIntegrity {
  ok: boolean;
  storedHash: string;
  computedHash: string;
}

export async function getActiveRulePack(): Promise<RulePack | null> {
  return asService(async (db) => {
    const r = await db.query<{ content_json: RulePack; is_active: boolean }>(
      `select content_json, is_active from knowledge.rule_packs
       where is_active order by published_at desc limit 1`);
    if (r.rows.length === 0) return null;
    return { ...r.rows[0].content_json, isActive: true };
  });
}

export async function getRulePackByVersion(version: string): Promise<RulePack | null> {
  return asService(async (db) => {
    const r = await db.query<{ content_json: RulePack; is_active: boolean }>(
      `select content_json, is_active from knowledge.rule_packs where version = $1`,
      [version]);
    if (r.rows.length === 0) return null;
    return { ...r.rows[0].content_json, isActive: r.rows[0].is_active };
  });
}

export async function listRulePacks(): Promise<Array<Record<string, unknown>>> {
  return asService(async (db) => {
    const r = await db.query(
      `select version, cpic_release, published_at, effective_from, expires_at,
              is_active, provenance_status, content_hash, curated_by, notes,
              (expires_at < now()) as expired
         from knowledge.rule_packs order by published_at desc`);
    return r.rows as Array<Record<string, unknown>>;
  });
}

/** Recompute the hash of a stored pack and compare it to the stored value. */
export function checkIntegrity(pack: RulePack): PackIntegrity {
  const computed = computeRulePackHash(pack as unknown as Record<string, unknown>);
  return { ok: computed === pack.contentHash, storedHash: pack.contentHash, computedHash: computed };
}

/**
 * How many cited sources in this pack has a human actually opened?
 * Surfaced in the UI and on rendered documents, because an unverified
 * citation is a claim the system cannot stand behind.
 */
export async function citationVerificationSummary(version: string): Promise<{
  total: number; verified: number; unverified: number; disputed: number;
}> {
  return asService(async (db) => {
    const r = await db.query<{ verification_status: string; n: string }>(
      `select e.verification_status, count(*)::text as n
         from knowledge.evidence_sources e
         join knowledge.rule_packs p on p.id = e.rule_pack_id
        where p.version = $1
        group by e.verification_status`, [version]);
    const out = { total: 0, verified: 0, unverified: 0, disputed: 0 };
    for (const row of r.rows) {
      const n = Number(row.n);
      out.total += n;
      if (row.verification_status === 'verified_primary_source') out.verified += n;
      else if (row.verification_status === 'disputed') out.disputed += n;
      else out.unverified += n;
    }
    return out;
  });
}
