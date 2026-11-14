// SPDX-License-Identifier: AGPL-3.0-only
const { execFileSync } = require('node:child_process');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { gzipSync } = require('node:zlib');
const { version, license } = require('../package.json');
if (execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()) {
  throw new Error('Commit tracked changes before preparing an exact-source release.');
}
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
mkdirSync('dist', { recursive: true });
const source = `irisbeat-${version}-source.tar.gz`;
writeFileSync('dist/' + source, gzipSync(execFileSync('git', ['archive', '--format=tar', `--prefix=irisbeat-${version}/`, revision], { maxBuffer: 16 * 1024 * 1024 }), { level: 9 }));
const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', 'dist'], { encoding: 'utf8' }))[0];
const sha256 = {};
for (const file of [source, packed.filename]) {
  sha256[file] = createHash('sha256').update(readFileSync('dist/' + file)).digest('hex');
}
writeFileSync('dist/release.json', JSON.stringify({ version, license, contractVersion: '1', revision,
  source: `https://github.com/webriot/irisbeat/tree/${revision}`, engineIntegrity: packed.integrity, sha256 }, null, 2) + '\n');
sha256['release.json'] = createHash('sha256').update(readFileSync('dist/release.json')).digest('hex');
writeFileSync('dist/SHA256SUMS', Object.entries(sha256).map(([file, hash]) => `${hash}  ${file}\n`).join(''));
console.log(`Prepared unpublished Irisbeat ${version} from ${revision}; no tag, release or deployment created.`);
