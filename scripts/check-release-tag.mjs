import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [manifest, packageMetadata] = await Promise.all([
  fs.readFile(path.join(root, 'manifest.json'), 'utf8').then(JSON.parse),
  fs.readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse)
]);
if (manifest.version !== packageMetadata.version) {
  throw new Error('manifest.json and package.json must publish the same version.');
}
const tag = process.env.GITHUB_REF_NAME || process.argv[2] || '';
if (!tag || tag !== 'v' + manifest.version) {
  throw new Error('Release tag ' + JSON.stringify(tag) + ' must equal v' + manifest.version + '.');
}
process.stdout.write('Release tag matches plugin version ' + manifest.version + '.\n');
