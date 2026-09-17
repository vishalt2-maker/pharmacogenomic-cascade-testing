/**
 * Canonical hashing for rule packs.
 *
 * The hash must be reproducible from the pack's own content, on any
 * machine, in any year -- otherwise "which rules produced this advisory"
 * has no verifiable answer. Keys are sorted recursively so that the hash
 * depends on content and never on key order or serialisation accident.
 *
 * `contentHash` and `signature` are excluded: a value cannot be part of
 * what it attests to.
 */
import crypto from 'node:crypto';

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) {
      if (src[k] === undefined) continue;
      out[k] = canonicalize(src[k]);
    }
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function computeRulePackHash(pack: Record<string, unknown>): string {
  const { contentHash: _c, signature: _s, ...rest } = pack as Record<string, unknown>;
  return sha256(canonicalJson(rest));
}
