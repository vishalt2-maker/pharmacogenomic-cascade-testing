/**
 * PUBLIC DEMONSTRATION MODE.
 *
 * Enabled by PCT_PUBLIC_DEMO=1. Off by default, so a local checkout behaves
 * exactly as it always has.
 *
 * This system has no authentication. The user switcher is a header shim, and
 * on a public URL that means anyone could act as a named clinician and sign
 * an advisory carrying a registration number. It also means anyone could type
 * real patient data into a system with no Data Processing Agreement behind
 * it, which the governance notes are explicit about.
 *
 * Public mode does three things about that:
 *
 *   1. The database is in-memory. Nothing is written to disk, and everything
 *      is discarded when the container restarts.
 *   2. Nobody reaches the application, or any API route, without first
 *      acknowledging what this is. The gate is server-side and cookie-backed
 *      rather than a banner in the page, so it cannot be stepped around by
 *      calling the API directly.
 *   3. Every response carries headers telling crawlers not to index it.
 *
 * None of this is security. It is a demonstration that states what it is.
 */
import type http from 'node:http';
import crypto from 'node:crypto';

export const IS_PUBLIC_DEMO = process.env.PCT_PUBLIC_DEMO === '1';

const COOKIE = 'pct_ack';
const ACK_VERSION = '2026-09-1';

/** Routes reachable before acknowledging: the gate itself and its assets. */
const OPEN_PATHS = new Set([
  '/', '/acknowledge', '/api/acknowledge', '/styles.css', '/api/health', '/healthz',
]);

function secret(): string {
  return process.env.PCT_ACK_SECRET ?? 'pct-public-demo-acknowledgement';
}

function sign(value: string): string {
  return crypto.createHmac('sha256', secret()).update(value).digest('hex').slice(0, 32);
}

export function issueToken(): string {
  return `${ACK_VERSION}.${sign(ACK_VERSION)}`;
}

function tokenValid(token: string | undefined): boolean {
  if (!token) return false;
  const [version, mac] = token.split('.');
  if (version !== ACK_VERSION || !mac) return false;
  const expected = sign(version);
  // Constant-time compare, because doing it properly costs nothing.
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function readCookie(req: http.IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k !== name) continue;
    const raw = rest.join('=');
    // A malformed percent-escape makes decodeURIComponent throw. A bad cookie
    // must be refused at the gate, not crash it into a 500.
    try { return decodeURIComponent(raw); } catch { return raw; }
  }
  return undefined;
}

export function hasAcknowledged(req: http.IncomingMessage): boolean {
  return tokenValid(readCookie(req, COOKIE));
}

/**
 * Session cookie: acknowledging once per browser session is the point, and a
 * year-long cookie would let someone forget what they agreed to.
 *
 * `Secure` is set only when the request actually arrived over HTTPS. A hosted
 * deployment sits behind a TLS-terminating proxy that sets x-forwarded-proto,
 * so it gets the flag; a developer on http://localhost would otherwise have
 * the cookie silently dropped by the browser and never get past the gate.
 */
export function acknowledgementCookie(req?: http.IncomingMessage): string {
  const proto = String(req?.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  const secure = proto === 'https' ? '; Secure' : '';
  return `${COOKIE}=${issueToken()}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

/**
 * Should this request be stopped at the gate?
 * Returns null to continue, or the reason to refuse.
 */
export function gate(
  req: http.IncomingMessage, pathname: string,
): 'show-gate' | 'refuse-api' | null {
  if (!IS_PUBLIC_DEMO) return null;
  if (OPEN_PATHS.has(pathname)) return null;
  if (hasAcknowledged(req)) return null;
  return pathname.startsWith('/api/') || pathname.startsWith('/cds-services')
    ? 'refuse-api'
    : 'show-gate';
}

/** Applied to every response in public mode. */
export function publicHeaders(): Record<string, string> {
  if (!IS_PUBLIC_DEMO) return {};
  return {
    'x-robots-tag': 'noindex, nofollow, noarchive',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  };
}
