import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inventory } from './installer-payload.mjs';
import { parseUpdateManifest, updateNames } from '../src/shared/update-format.mjs';
const execute = promisify(execFile);
const zipScript = `import json, os, sys, zipfile
root, target, inventory = sys.argv[1:]
with open(inventory, encoding='utf-8') as f: files = json.load(f)
with zipfile.ZipFile(target, 'x', zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as z:
 for item in files: z.write(os.path.join(root, *item['path'].split('/')), item['path'])
`;
export async function createUpdate(root, resources, output, overrides = {}) {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const protocol = await readFile(path.join(root, 'src/shared/protocol.ts'), 'utf8');
  const version = overrides.version ?? pkg.version, names = updateNames(version);
  const files = (await inventory(resources)).files;
  await mkdir(output, { recursive: true });
  const archive = path.join(output, names.bundle), temporary = path.join(output, `.update-inventory-${process.pid}.json`);
  await writeFile(temporary, JSON.stringify(files), { flag: 'wx' });
  try {
    await execute(process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'), ['-I', '-c', zipScript, path.resolve(resources), path.resolve(archive), path.resolve(temporary)], { timeout: 300000, maxBuffer: 1024 * 1024, windowsHide: true });
    const hash = createHash('sha256'); for await (const chunk of createReadStream(archive)) hash.update(chunk);
    const manifest = parseUpdateManifest({ schema: 1, bootstrap: 1, version, electron: pkg.devDependencies.electron, platform: 'win32', arch: 'x64', protocol: Number(/PROTOCOL_VERSION\s*=\s*(\d+)/.exec(protocol)?.[1]), minimumBackendApi: overrides.minimumBackendApi ?? pkg.agentberthUpdates?.minimumBackendApi ?? Number(/API_VERSION\s*=\s*(\d+)/.exec(protocol)?.[1]), bundle: { name: names.bundle, size: (await stat(archive)).size, sha256: hash.digest('hex') }, files });
    await writeFile(path.join(output, names.manifest), JSON.stringify(manifest, null, 2) + '\n');
    return manifest;
  } catch (error) { await rm(archive, { force: true }); throw error; }
  finally { await rm(temporary, { force: true }); }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const root = process.cwd(); const manifest = await createUpdate(root, path.join(root, 'release/win-unpacked/resources'), path.join(root, 'release'));
  console.log(`Created ${manifest.bundle.name}: ${(manifest.bundle.size / 1024 / 1024).toFixed(1)} MiB, ${manifest.files.length} verified files`);
}
