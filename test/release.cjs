// SPDX-License-Identifier: AGPL-3.0-only
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { version } = require('../package.json');
execFileSync('npm', ['run', 'release:prepare'], { stdio: 'inherit' });
const manifest = JSON.parse(readFileSync('dist/release.json'));
assert.equal(manifest.version, version);
assert.match(manifest.revision, /^[a-f0-9]{40}$/);
for (const [file, hash] of Object.entries(manifest.sha256)) {
  assert.equal(createHash('sha256').update(readFileSync('dist/' + file)).digest('hex'), hash);
}
const source = `dist/irisbeat-${version}-source.tar.gz`;
const listing = execFileSync('tar', ['-tzf', source], { encoding: 'utf8' }).split('\n');
for (const file of ['src/index.ts', 'src/ui.ts', 'LICENSE', 'package-lock.json', 'wrangler.jsonc', '.dev.vars.example', 'docs/install.md', 'scripts/release.cjs']) {
  assert.ok(listing.includes(`irisbeat-${version}/${file}`), 'deployable source includes ' + file);
}
assert.ok(!listing.some(file => /(?:node_modules|\.dev\.vars$|\.env$|dist\/)/.test(file)));
const engine = execFileSync('tar', ['-tzf', `dist/irisbeat-${version}.tgz`], { encoding: 'utf8' });
assert.ok(!engine.includes('package/test/'), 'consumer fixtures stay out of engine');
const hashes = { ...manifest.sha256 };
execFileSync('npm', ['run', 'release:prepare'], { stdio: 'pipe' });
assert.deepEqual(JSON.parse(readFileSync('dist/release.json')).sha256, hashes, 'same committed revision packs reproducibly');
console.log('PASS reproducible versioned source/engine artifacts, integrity, deployable source and fixture exclusion');
