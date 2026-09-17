/**
 * Patient identifier handling.
 *
 * The medical record number is never stored in plain text. It is stored
 * twice, for two different jobs:
 *
 *   mrn_hash       a keyed digest, so the same patient can be matched on a
 *                  later visit without the number being readable.
 *   mrn_encrypted  reversible ciphertext, so a clinician can be shown the
 *                  number they need to find the chart.
 *
 * Encryption is done in the APPLICATION, not in SQL. pgcrypto would work,
 * but it takes the key as a literal in the statement, which puts the key
 * into query logs, `pg_stat_activity` and any slow-query trace. Keeping it
 * here means the database never sees the key at all.
 *
 * PRODUCTION NOTE: the key is read from an environment variable in this
 * build, which is adequate for a concept build and NOT adequate for
 * deployment. It belongs in a managed key service, rotated, with the
 * ciphertext carrying a key version. See docs/GOVERNANCE.md.
 */
import crypto from 'node:crypto';

const KEY_ENV = 'PCT_MRN_KEY';

function key(): Buffer {
  const raw = process.env[KEY_ENV];
  if (!raw) {
    // A demo key, clearly labelled. Refusing outright would make the demo
    // unrunnable; pretending it is secret would be worse.
    return crypto.createHash('sha256').update('pct-concept-build-demo-key-not-secret').digest();
  }
  return crypto.createHash('sha256').update(raw).digest();
}

/** Keyed digest, salted per organisation so the same MRN at two hospitals differs. */
export function hashMrn(mrn: string, orgId: string): string {
  return crypto.createHmac('sha256', key())
    .update(`${orgId}:${mrn.trim().toUpperCase()}`)
    .digest('hex');
}

/** AES-256-GCM. Layout: version(1) || iv(12) || tag(16) || ciphertext. */
export function encryptMrn(mrn: string): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(mrn.trim(), 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ct]);
}

export function decryptMrn(blob: Buffer | Uint8Array): string {
  const b = Buffer.from(blob);
  if (b.length < 29 || b[0] !== 1) throw new Error('MRN_CIPHERTEXT_UNRECOGNISED');
  const iv = b.subarray(1, 13);
  const tag = b.subarray(13, 29);
  const ct = b.subarray(29);
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

/** Only ever show the tail. Enough to find a chart, not enough to leak a list. */
export function maskMrn(mrn: string): string {
  const s = mrn.trim();
  return s.length <= 4 ? '•'.repeat(s.length) : `${'•'.repeat(s.length - 4)}${s.slice(-4)}`;
}
