/*
 * Delete the local demonstration database.
 *
 * Plain JavaScript rather than `rm -rf` in an npm script, so that the
 * project resets the same way on Windows as it does on macOS and Linux.
 *
 * The .cjs extension is load-bearing: package.json declares
 * "type": "module", so a plain .js file here would be parsed as ESM and
 * `require` would not exist.
 *
 * This removes the PGlite data directory only. It never touches anything
 * outside it, and it refuses a path that does not look like one of ours.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = process.env.PCT_DATA_DIR || path.join(__dirname, '..', '.data', 'pgdata');

if (target === ':memory:') {
  process.exit(0);
}

const resolved = path.resolve(target);
const projectRoot = path.resolve(path.join(__dirname, '..'));

// A destructive default plus an environment variable is a bad combination.
// Refuse anything outside the project unless it is explicitly confirmed.
if (!resolved.startsWith(projectRoot) && process.env.PCT_ALLOW_EXTERNAL_RESET !== 'yes') {
  process.stderr.write(
    '\n  Refusing to delete ' + resolved + '\n' +
    '  It sits outside the project directory. Set PCT_ALLOW_EXTERNAL_RESET=yes\n' +
    '  if that is genuinely what you want.\n\n');
  process.exit(1);
}

if (fs.existsSync(resolved)) {
  fs.rmSync(resolved, { recursive: true, force: true });
  process.stdout.write('Removed ' + path.relative(projectRoot, resolved) + '\n');
}
