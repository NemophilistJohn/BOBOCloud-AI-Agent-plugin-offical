import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptPath), '..');
const manifestPath = path.join(root, 'manifest.json');
const packageMetadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const sourcePath = path.join(root, 'src', 'extension.js');
const outputPath = path.join(root, 'dist', 'extension.js');
const artifactsRoot = path.join(root, 'artifacts');
const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_PACKAGE_ENTRIES = 32;
const packageFiles = Object.freeze([
  'dist/extension.js',
  'language-packs/en/messages.json',
  'language-packs/ja/messages.json',
  'language-packs/zh-CN/messages.json'
]);

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipEntry(name, content, offset) {
  const nameBytes = Buffer.from(name, 'utf8');
  const compressed = zlib.deflateRawSync(content, { level: 9 });
  const checksum = crc32(content);
  const flags = 0x0800;
  const method = 8;
  const dosTime = 0;
  const dosDate = 0x0021;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(flags, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(dosTime, 10);
  local.writeUInt16LE(dosDate, 12);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x0314, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(flags, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(dosTime, 12);
  central.writeUInt16LE(dosDate, 14);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  central.writeUInt32LE(offset, 42);
  return {
    local: Buffer.concat([local, nameBytes, compressed]),
    central: Buffer.concat([central, nameBytes])
  };
}

export function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const encoded = zipEntry(entry.name, entry.content, offset);
    localParts.push(encoded.local);
    centralParts.push(encoded.central);
    offset += encoded.local.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, end]);
}

export function readZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22 || buffer.length > MAX_ARCHIVE_BYTES) throw new Error('ZIP archive size is invalid.');
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('ZIP end record is missing.');
  const count = buffer.readUInt16LE(end + 10);
  if (count < 1 || count > MAX_PACKAGE_ENTRIES) throw new Error('ZIP entry count is invalid.');
  let cursor = buffer.readUInt32LE(end + 16);
  const values = new Map();
  for (let index = 0; index < count; index += 1) {
    if (cursor < 0 || cursor + 46 > end) throw new Error('ZIP central directory is truncated.');
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('ZIP central directory is invalid.');
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const expectedCrc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (flags !== 0x0800 || (method !== 0 && method !== 8)) throw new Error('ZIP entry flags or compression method are unsupported.');
    if (!name || name.includes('\\') || path.posix.normalize(name) !== name || name.startsWith('/') || name.startsWith('../') || name === '..') {
      throw new Error('ZIP entry path is invalid.');
    }
    if (values.has(name)) throw new Error('ZIP archive contains a duplicate entry: ' + name + '.');
    if (uncompressedSize > MAX_ENTRY_BYTES || compressedSize > MAX_ARCHIVE_BYTES) throw new Error('ZIP entry size exceeds the package limit.');
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('ZIP local entry is invalid.');
    const localFlags = buffer.readUInt16LE(localOffset + 6);
    const localMethod = buffer.readUInt16LE(localOffset + 8);
    const localCrc = buffer.readUInt32LE(localOffset + 14);
    const localCompressedSize = buffer.readUInt32LE(localOffset + 18);
    const localUncompressedSize = buffer.readUInt32LE(localOffset + 22);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const localName = buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString('utf8');
    if (localFlags !== flags || localMethod !== method || localCrc !== expectedCrc || localCompressedSize !== compressedSize ||
        localUncompressedSize !== uncompressedSize || localName !== name) {
      throw new Error('ZIP local and central entry metadata do not match.');
    }
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart < 0 || dataStart + compressedSize > buffer.length) throw new Error('ZIP entry data is truncated.');
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    const content = method === 8 ? zlib.inflateRawSync(compressed, { maxOutputLength: MAX_ENTRY_BYTES }) : Buffer.from(compressed);
    if (content.length !== uncompressedSize) throw new Error('ZIP entry size mismatch for ' + name + '.');
    if (crc32(content) !== expectedCrc) throw new Error('ZIP CRC mismatch for ' + name + '.');
    values.set(name, content);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== end) throw new Error('ZIP central directory length is invalid.');
  return values;
}

function assertManifest(manifest) {
  if (manifest.schemaVersion !== 1 || manifest.id !== 'bobocloud.ai-agent' ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version) || manifest.version !== packageMetadata.version) {
    throw new Error('Unexpected plugin identity or package schema.');
  }
  if (manifest.engines.bobocloud !== '>=2.8.1 <3.0.0' || manifest.engines.pluginApi !== '^1.5.0' || manifest.main !== 'dist/extension.js') {
    throw new Error('BOBOCLOUD range, Plugin API range, or entry point is invalid.');
  }
  if (!Array.isArray(manifest.activationEvents) || !manifest.activationEvents.includes('onStartupFinished')) {
    throw new Error('onStartupFinished activation is required.');
  }
  const requiredPermissions = [
    'commands.register', 'agents.register', 'models.generate', 'workspace.read',
    'workspace.write', 'process.execute', 'skills.read', 'storage.local'
  ];
  if (!Array.isArray(manifest.permissions) || JSON.stringify([...manifest.permissions].sort()) !== JSON.stringify([...requiredPermissions].sort())) {
    throw new Error('Plugin permissions must match the reviewed Agent permission set exactly.');
  }
  const expectedLocalization = {
    default: 'language-packs/en/messages.json',
    en: 'language-packs/en/messages.json',
    'zh-CN': 'language-packs/zh-CN/messages.json',
    ja: 'language-packs/ja/messages.json'
  };
  if (JSON.stringify(manifest.localization) !== JSON.stringify(expectedLocalization)) {
    throw new Error('Plugin localization paths are invalid.');
  }
  if (!manifest.integrity || manifest.integrity.algorithm !== 'sha256') throw new Error('Plugin integrity algorithm must be SHA-256.');
  const declared = Object.keys(manifest.integrity && manifest.integrity.files || {}).sort();
  if (JSON.stringify(declared) !== JSON.stringify([...packageFiles].sort())) {
    throw new Error('integrity.files must cover every package file exactly once.');
  }
  for (const digest of Object.values(manifest.integrity.files)) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Plugin integrity contains an invalid SHA-256 digest.');
  }
}

export async function buildPackage(options = {}) {
  const source = await fs.readFile(sourcePath);
  const sourceText = source.toString('utf8');
  if (/^\s*import\s/m.test(sourceText)) throw new Error('The activation entry must not contain relative runtime imports.');
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, source);

  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.integrity = { algorithm: 'sha256', files: {} };
  for (const relativePath of packageFiles) {
    manifest.integrity.files[relativePath] = sha256(await fs.readFile(path.join(root, ...relativePath.split('/'))));
  }
  assertManifest(manifest);
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  await fs.writeFile(manifestPath, manifestBytes);
  if (options.buildOnly) return { manifest, artifactPath: null, sha256: null, size: null };

  const entries = [{ name: 'manifest.json', content: manifestBytes }];
  for (const relativePath of packageFiles) entries.push({
    name: relativePath,
    content: await fs.readFile(path.join(root, ...relativePath.split('/')))
  });
  const archive = createZip(entries);
  await fs.mkdir(artifactsRoot, { recursive: true });
  const artifactPath = path.join(artifactsRoot, manifest.id + '-' + manifest.version + '.boboplugin');
  await fs.writeFile(artifactPath, archive);
  const digest = sha256(archive);
  await fs.writeFile(artifactPath + '.sha256', digest + '  ' + path.basename(artifactPath) + '\n', 'utf8');
  await verifyPackage(artifactPath, { compareWorkspace: true, verifyChecksum: true });
  return { manifest, artifactPath, sha256: digest, size: archive.length };
}

export async function verifyPackage(artifactPath, options = {}) {
  const archive = await fs.readFile(artifactPath);
  const entries = readZip(archive);
  const names = [...entries.keys()].sort();
  const expectedNames = ['manifest.json', ...packageFiles].sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) throw new Error('Archive contains an unexpected file set.');
  const manifest = JSON.parse(entries.get('manifest.json').toString('utf8'));
  assertManifest(manifest);
  const expectedArtifactName = manifest.id + '-' + manifest.version + '.boboplugin';
  if (path.basename(artifactPath) !== expectedArtifactName) throw new Error('Artifact filename does not match the package identity.');
  for (const relativePath of packageFiles) {
    if (sha256(entries.get(relativePath)) !== manifest.integrity.files[relativePath]) {
      throw new Error('Integrity mismatch for ' + relativePath + '.');
    }
  }
  if (options.compareWorkspace === true) {
    const workspaceManifest = await fs.readFile(manifestPath);
    if (!workspaceManifest.equals(entries.get('manifest.json'))) throw new Error('Artifact manifest does not match the workspace manifest.');
    for (const relativePath of packageFiles) {
      const workspaceFile = await fs.readFile(path.join(root, ...relativePath.split('/')));
      if (!workspaceFile.equals(entries.get(relativePath))) throw new Error('Artifact entry does not match the workspace file: ' + relativePath + '.');
    }
  }
  const archiveDigest = sha256(archive);
  if (options.verifyChecksum === true) {
    const checksum = (await fs.readFile(artifactPath + '.sha256', 'utf8')).trim();
    const match = checksum.match(/^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/);
    if (!match || match[1] !== archiveDigest || match[2] !== expectedArtifactName) throw new Error('Artifact checksum file is invalid.');
  }
  return { manifest, sha256: archiveDigest, size: archive.length, files: names };
}

async function main() {
  const verifyOnly = process.argv.includes('--verify-only');
  if (verifyOnly) {
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const artifactPath = path.join(artifactsRoot, manifest.id + '-' + manifest.version + '.boboplugin');
    const result = await verifyPackage(artifactPath, { compareWorkspace: true, verifyChecksum: true });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  const result = await buildPackage({ buildOnly: process.argv.includes('--build-only') });
  process.stdout.write(JSON.stringify({
    id: result.manifest.id,
    version: result.manifest.version,
    artifact: result.artifactPath ? path.relative(root, result.artifactPath).replace(/\\/g, '/') : null,
    sha256: result.sha256,
    size: result.size
  }, null, 2) + '\n');
}

if (path.resolve(process.argv[1] || '') === scriptPath) {
  main().catch((error) => {
    process.stderr.write((error && error.stack || String(error)) + '\n');
    process.exitCode = 1;
  });
}
