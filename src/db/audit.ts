/**
 * The append-only audit log.
 *
 * The `detail` column takes CODES AND IDENTIFIERS ONLY. Never clinical free
 * text, never a diagnosis, never a drug name typed by a user. An audit log
 * that accumulates clinical narrative becomes a second, unprotected copy of
 * the record, and it is usually the copy with the loosest access controls.
 *
 * That constraint is enforced here rather than trusted to callers.
 */
import type { Queryer } from './client.ts';

const MAX_VALUE_LEN = 64;
const ALLOWED_KEY = /^[a-z][a-z0-9_]{0,40}$/;

export interface AuditEntry {
  action: string;
  objectType: string;
  objectId?: string | null;
  reasonCodes?: string[];
  detail?: Record<string, string | number | boolean | null>;
}

export class AuditDetailRejected extends Error {
  constructor(message: string) {
    super(`AUDIT_DETAIL_REJECTED: ${message}`);
    this.name = 'AuditDetailRejected';
  }
}

/**
 * Reject anything that looks like prose before it can be written.
 * A value that is long, or contains sentence punctuation with spaces, is
 * treated as narrative and refused.
 */
export function assertCodesOnly(detail: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(detail)) {
    if (!ALLOWED_KEY.test(k)) {
      throw new AuditDetailRejected(`key "${k}" is not a snake_case code`);
    }
    if (v === null || typeof v === 'boolean' || typeof v === 'number') continue;
    if (typeof v !== 'string') {
      throw new AuditDetailRejected(`key "${k}" holds a ${typeof v}; only codes, ids, numbers and booleans are permitted`);
    }
    if (v.length > MAX_VALUE_LEN) {
      throw new AuditDetailRejected(
        `key "${k}" holds ${v.length} characters; the audit log takes codes and identifiers, not clinical free text`);
    }
    if (/\s\S+\s\S+\s/.test(v) || /[.!?]\s/.test(v)) {
      throw new AuditDetailRejected(
        `key "${k}" looks like prose; the audit log takes codes and identifiers, not clinical free text`);
    }
  }
}

export async function audit(
  q: Queryer,
  ctx: { userId: string; orgId: string; ipHash?: string | null },
  entry: AuditEntry,
): Promise<void> {
  if (entry.detail) assertCodesOnly(entry.detail);
  await q.query(
    `insert into clinical.audit_log
       (actor_id, org_id, action, object_type, object_id, reason_codes, detail, ip_hash)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [ctx.userId, ctx.orgId, entry.action, entry.objectType, entry.objectId ?? null,
     entry.reasonCodes ?? null, entry.detail ? JSON.stringify(entry.detail) : null,
     ctx.ipHash ?? null]);
}
