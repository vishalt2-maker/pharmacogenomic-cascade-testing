/**
 * PUBLIC DEMONSTRATION MODE TESTS.
 *
 * This mode exists because the application has no authentication, and
 * putting it on a public URL without saying so would be dishonest. The gate
 * is the honesty, so it needs to actually hold: it must not be steppable
 * around by calling the API directly, and it must not be forgeable.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { gate, hasAcknowledged, issueToken, readCookie } from '../src/api/public-demo.ts';
import type http from 'node:http';

/** A request object with just the headers the gate looks at. */
function req(cookie?: string, headers: Record<string, string> = {}): http.IncomingMessage {
  return { headers: { ...(cookie ? { cookie } : {}), ...headers } } as http.IncomingMessage;
}

describe('the acknowledgement token', () => {
  test('a freshly issued token is accepted', () => {
    assert.equal(hasAcknowledged(req(`pct_ack=${issueToken()}`)), true);
  });

  test('no cookie is not acknowledged', () => {
    assert.equal(hasAcknowledged(req()), false);
  });

  test('a token with a forged signature is rejected', () => {
    const [version] = issueToken().split('.');
    assert.equal(hasAcknowledged(req(`pct_ack=${version}.${'0'.repeat(32)}`)), false);
  });

  test('a token with no signature is rejected', () => {
    assert.equal(hasAcknowledged(req('pct_ack=2026-09-1')), false);
  });

  test('a token for a different notice version is rejected', () => {
    // Changing the wording of the notice invalidates prior acknowledgements,
    // which is the point of versioning it.
    assert.equal(hasAcknowledged(req('pct_ack=1999-01-1.deadbeefdeadbeefdeadbeefdeadbeef')), false);
  });

  test('garbage is rejected rather than throwing', () => {
    for (const junk of ['', 'x', '....', 'a.b.c.d', '%%%', 'pct_ack']) {
      assert.equal(hasAcknowledged(req(`pct_ack=${junk}`)), false);
    }
  });

  test('cookies are parsed out of a realistic header', () => {
    const t = issueToken();
    assert.equal(readCookie(req(`other=1; pct_ack=${t}; last=2`), 'pct_ack'), t);
    assert.equal(readCookie(req('other=1'), 'pct_ack'), undefined);
  });
});

describe('what the gate lets through', () => {
  const IS_ON = process.env.PCT_PUBLIC_DEMO === '1';

  test('the gate is OFF unless explicitly enabled', () => {
    // A local checkout must behave exactly as it always has.
    assert.equal(IS_ON, false, 'this test file must run without PCT_PUBLIC_DEMO set');
    assert.equal(gate(req(), '/api/cases'), null);
    assert.equal(gate(req(), '/'), null);
  });
});

describe('the gate, with public mode forced on', () => {
  let gateOn: typeof gate;

  before(async () => {
    process.env.PCT_PUBLIC_DEMO = '1';
    // Fresh module instance so IS_PUBLIC_DEMO is evaluated with the flag set.
    const mod = await import(`../src/api/public-demo.ts?public=1`);
    gateOn = mod.gate;
  });
  after(() => { delete process.env.PCT_PUBLIC_DEMO; });

  test('an unacknowledged visitor is shown the notice', () => {
    assert.equal(gateOn(req(), '/index.html'), 'show-gate');
  });

  test('THE API CANNOT BE USED TO STEP AROUND THE NOTICE', () => {
    for (const path of ['/api/cases', '/api/advisories', '/api/reference',
                        '/cds-services/pct-index-case-review']) {
      assert.equal(gateOn(req(), path), 'refuse-api', `${path} was reachable unacknowledged`);
    }
  });

  test('the notice itself, its stylesheet and the health probe stay open', () => {
    for (const path of ['/', '/acknowledge', '/api/acknowledge', '/styles.css', '/healthz']) {
      assert.equal(gateOn(req(), path), null, `${path} must be reachable to show the notice`);
    }
  });

  test('once acknowledged, everything is reachable', () => {
    const ok = req(`pct_ack=${issueToken()}`);
    for (const path of ['/index.html', '/api/cases', '/cds-services']) {
      assert.equal(gateOn(ok, path), null);
    }
  });

  test('a forged cookie does not open the API', () => {
    assert.equal(gateOn(req('pct_ack=2026-09-1.' + '0'.repeat(32)), '/api/cases'), 'refuse-api');
  });
});

describe('the deployed image is configured for public exposure', () => {
  test('the Dockerfile runs as a non-root user and sets in-memory storage', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { PROJECT_ROOT } = await import('../src/db/client.ts');
    const df = fs.readFileSync(path.join(PROJECT_ROOT, 'Dockerfile'), 'utf8');
    assert.match(df, /USER node/, 'the container must not run as root');
    assert.match(df, /PCT_DATA_DIR=:memory:/, 'nothing should be written to disk');
    assert.match(df, /PCT_PUBLIC_DEMO=1/, 'the gate must be on in the image');
    assert.ok(!/COPY \. /.test(df), 'copy only what the image needs, not the whole tree');
  });

  test('the docker context excludes data, tests and git history', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { PROJECT_ROOT } = await import('../src/db/client.ts');
    const di = fs.readFileSync(path.join(PROJECT_ROOT, '.dockerignore'), 'utf8');
    for (const entry of ['node_modules/', '.data/', '.git/', 'demo-output/']) {
      assert.ok(di.includes(entry), `.dockerignore should exclude ${entry}`);
    }
  });
});
