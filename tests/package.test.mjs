import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildPackage, createZip, readZip, sha256, verifyPackage } from '../scripts/package.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('builds a deterministic schema-1 package with complete integrity coverage', async () => {
  const first = await buildPackage();
  const firstBytes = await fs.readFile(first.artifactPath);
  const second = await buildPackage();
  const secondBytes = await fs.readFile(second.artifactPath);
  assert.deepEqual(secondBytes, firstBytes);
  assert.equal(second.sha256, sha256(secondBytes));

  const verified = await verifyPackage(second.artifactPath, { compareWorkspace: true, verifyChecksum: true });
  assert.equal(verified.manifest.id, 'bobocloud.ai-agent');
  assert.equal(verified.manifest.engines.pluginApi, '^1.5.0');
  assert.equal(verified.manifest.engines.bobocloud, '>=2.8.1 <3.0.0');
  assert.deepEqual(verified.files, [
    'dist/extension.js',
    'language-packs/en/messages.json',
    'language-packs/ja/messages.json',
    'language-packs/zh-CN/messages.json',
    'manifest.json'
  ]);
  const entries = readZip(secondBytes);
  assert.equal(entries.has('src/extension.js'), false);
  assert.equal(entries.has('scripts/package.mjs'), false);
  assert.equal(entries.get('dist/extension.js').toString('utf8'), await fs.readFile(path.join(root, 'src', 'extension.js'), 'utf8'));
});

test('rejects duplicate archive entries and mismatched checksum metadata', async () => {
  const duplicate = createZip([
    { name: 'manifest.json', content: Buffer.from('{}') },
    { name: 'manifest.json', content: Buffer.from('{}') }
  ]);
  assert.throws(() => readZip(duplicate), /duplicate entry/i);
  const traversal = createZip([{ name: '../manifest.json', content: Buffer.from('{}') }]);
  assert.throws(() => readZip(traversal), /entry path is invalid/i);

  const built = await buildPackage();
  const checksumPath = built.artifactPath + '.sha256';
  const originalChecksum = await fs.readFile(checksumPath);
  try {
    await fs.writeFile(checksumPath, '0'.repeat(64) + '  ' + path.basename(built.artifactPath) + '\n', 'utf8');
    await assert.rejects(
      verifyPackage(built.artifactPath, { compareWorkspace: true, verifyChecksum: true }),
      /checksum file is invalid/i
    );
  } finally {
    await fs.writeFile(checksumPath, originalChecksum);
  }
});

test('ships flat and complete English, Simplified Chinese, and Japanese message catalogs', async () => {
  const catalogs = await Promise.all(['en', 'zh-CN', 'ja'].map(async (locale) => JSON.parse(
    await fs.readFile(path.join(root, 'language-packs', locale, 'messages.json'), 'utf8')
  )));
  const expectedKeys = Object.keys(catalogs[0]).sort();
  assert.equal(expectedKeys.length > 40, true);
  for (const catalog of catalogs) {
    assert.deepEqual(Object.keys(catalog).sort(), expectedKeys);
    assert.equal(Object.values(catalog).every((value) => typeof value === 'string'), true);
  }
  const source = await fs.readFile(path.join(root, 'src', 'extension.js'), 'utf8');
  const prefixes = new Set(['agent', 'command', 'session', 'goal', 'state', 'error', 'timeline', 'approval', 'tool', 'message']);
  const protocolKeys = new Set(['state.merge', 'session.merge', 'message.upsert', 'timeline.upsert']);
  const referenced = [...source.matchAll(/['"]([a-z]+(?:\.[A-Za-z0-9]+)+)['"]/g)]
    .map((match) => match[1])
    .filter((key) => prefixes.has(key.split('.')[0]) && !protocolKeys.has(key));
  const missing = [...new Set(referenced)].filter((key) => !Object.hasOwn(catalogs[0], key));
  assert.deepEqual(missing, [], 'every plugin-owned visible string key must be localized');
});
