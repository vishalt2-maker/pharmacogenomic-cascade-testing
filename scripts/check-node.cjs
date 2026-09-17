/*
 * Node version preflight.
 *
 * Deliberately plain, old-fashioned JavaScript with no modern syntax. This
 * file has to PARSE on whatever Node the person happens to have, including
 * one far too old to run the project, so that they get a sentence they can
 * act on instead of a SyntaxError from a file they have never seen. The
 * .cjs extension keeps it CommonJS regardless of what package.json says.
 *
 * The project runs TypeScript directly, with no build step. Node strips the
 * types itself. That became the default behaviour in Node 22.18.0 and in
 * Node 23.6.0; between 22.6 and 22.17 it exists but needs a flag.
 */
'use strict';

var raw = process.versions.node;
var parts = raw.split('.').map(Number);
var major = parts[0];
var minor = parts[1];

function ok() {
  if (major >= 24) return true;
  if (major === 23) return minor >= 6;
  if (major === 22) return minor >= 18;
  return false;
}

function needsFlagOnly() {
  // Type stripping exists here, but only behind --experimental-strip-types.
  if (major === 22) return minor >= 6 && minor < 18;
  if (major === 23) return minor < 6;
  return false;
}

if (ok()) {
  process.exit(0);
}

var lines = [];
lines.push('');
lines.push('  This project needs Node 22.18 or later, and you are on ' + raw + '.');
lines.push('');

if (needsFlagOnly()) {
  lines.push('  Your Node can run TypeScript directly, but only behind a flag.');
  lines.push('  Either upgrade, which is simpler, or set this and try again:');
  lines.push('');
  lines.push('      export NODE_OPTIONS=--experimental-strip-types');
  lines.push('');
} else {
  lines.push('  There is no build step. Node runs the TypeScript source itself,');
  lines.push('  and that behaviour arrived in Node 22.18.');
  lines.push('');
}

lines.push('  To upgrade:');
lines.push('');
lines.push('      nvm install 22 && nvm use 22       (nvm)');
lines.push('      brew install node                  (macOS, Homebrew)');
lines.push('      winget install OpenJS.NodeJS       (Windows)');
lines.push('');
lines.push('  Or download an installer from https://nodejs.org');
lines.push('');

process.stderr.write(lines.join('\n') + '\n');
process.exit(1);
