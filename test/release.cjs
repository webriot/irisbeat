// SPDX-License-Identifier: AGPL-3.0-only
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readFileSync, writeFileSync, rmSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { version } = require('../package.json');
const probe = `src/release-untracked-probe-${process.pid}.txt`;
writeFileSync(probe, 'untracked local content must never ship');
const callerUmask = process.umask(0o022);
try {
  execFileSync('npm', ['run', 'release:prepare'], { stdio: 'inherit' });
  const manifest = JSON.parse(readFileSync('dist/release.json'));
  assert.equal(manifest.version, version);
  assert.equal(manifest.revision, execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  const sourceArchive = `irisbeat-${version}-source.tar.gz`;
  const engineArchive = `irisbeat-${version}.tgz`;
  assert.deepEqual(new Set(Object.keys(manifest.sha256)), new Set([sourceArchive, engineArchive]));
  for (const [file, hash] of Object.entries(manifest.sha256)) {
    assert.equal(createHash('sha256').update(readFileSync('dist/' + file)).digest('hex'), hash);
  }
  const listing = execFileSync('tar', ['-tzf', 'dist/' + sourceArchive], { encoding: 'utf8' }).split('\n');
  for (const file of [
    'src/worker.ts', 'src/index.ts', 'src/ui.tsx', 'LICENSE', 'package-lock.json', 'wrangler.jsonc',
    'wrangler.delivery.jsonc', 'src/notification-delivery.ts', 'NOTICE', '.dev.vars.example',
    'docs/README.md', 'docs/install.md', 'scripts/release.cjs',
  ]) {
    assert.ok(listing.includes(`irisbeat-${version}/${file}`), 'deployable source includes ' + file);
  }
  assert.ok(!listing.some(file => /(?:node_modules|\.dev\.vars$|\.env$|dist\/)/.test(file)));
  assert.ok(!listing.includes(`irisbeat-${version}/${probe}`), 'untracked files stay out of source archive');
  const engine = execFileSync('tar', ['-tzf', 'dist/' + engineArchive], { encoding: 'utf8' });
  const engineFiles = new Set(engine.split('\n'));
  for (const file of [
    'README.md', 'GLOSSARY.md', 'docs/README.md', 'docs/install.md', 'docs/development.md',
    'docs/hosted-contract.md', 'docs/maintenance-api.md', 'docs/history-api.md',
    'docs/heartbeat-api.md', 'docs/monitor-api.md', 'docs/tcp-monitoring.md',
    'docs/agents/domain.md', 'docs/agents/issue-tracker.md', 'docs/agents/triage-labels.md',
    'LICENSE', 'NOTICE', 'wrangler.jsonc', 'wrangler.delivery.jsonc',
    'src/index.ts', 'src/notification-delivery.ts',
  ]) {
    assert.ok(engineFiles.has('package/' + file), 'engine includes ' + file);
  }
  assert.ok(!engine.includes('package/test/'), 'consumer fixtures stay out of engine');
  assert.ok(!engine.includes(probe.slice(4)), 'untracked local source content stays out of the engine');
  const hashes = { ...manifest.sha256 };
  process.umask(0o077);
  execFileSync('npm', ['run', 'release:prepare'], { stdio: 'pipe' });
  assert.deepEqual(JSON.parse(readFileSync('dist/release.json')).sha256, hashes, 'same commit packs reproducibly across file-creation masks');
  console.log('PASS reproducible versioned source/engine artifacts, integrity, deployable source and fixture exclusion');
} finally {
  process.umask(callerUmask);
  rmSync(probe, { force: true });
}
