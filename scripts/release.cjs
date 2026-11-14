// SPDX-License-Identifier: AGPL-3.0-only
const { execFileSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { join } = require('node:path');
const { gzipSync } = require('node:zlib');
const { version, license } = require('../package.json');
if (execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()) {
  throw new Error('Commit tracked changes before preparing an exact-source release.');
}
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
mkdirSync('dist', { recursive: true });
const source = `irisbeat-${version}-source.tar.gz`;
writeFileSync('dist/' + source, gzipSync(execFileSync('git', ['archive', '--format=tar', `--prefix=irisbeat-${version}/`, revision], { maxBuffer: 16 * 1024 * 1024 }), { level: 9 }));
// Pack only committed source; npm's files allowlist alone also includes untracked files.
mkdirSync('.tmp', { recursive: true });
const temporary = mkdtempSync(join(process.cwd(), '.tmp/release-'));
let packed;
try {
  execFileSync('tar', ['-xzf', join(process.cwd(), 'dist', source), '-C', temporary]);
  packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', join(process.cwd(), 'dist')], { cwd: join(temporary, `irisbeat-${version}`), encoding: 'utf8' }))[0];
} finally { rmSync(temporary, { recursive: true, force: true }); }
const sha256 = {};
for (const file of [source, packed.filename]) {
  sha256[file] = createHash('sha256').update(readFileSync('dist/' + file)).digest('hex');
}
writeFileSync('dist/release.json', JSON.stringify({ version, license, contractVersion: '1', revision,
  source: `https://github.com/webriot/irisbeat/tree/${revision}`, engineIntegrity: packed.integrity, sha256 }, null, 2) + '\n');
sha256['release.json'] = createHash('sha256').update(readFileSync('dist/release.json')).digest('hex');
writeFileSync('dist/SHA256SUMS', Object.entries(sha256).map(([file, hash]) => `${hash}  ${file}\n`).join(''));
console.log(`Prepared unpublished Irisbeat ${version} from ${revision}; no tag, release or deployment created.`);
