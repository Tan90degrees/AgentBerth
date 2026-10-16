import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export async function inventory(root) {
  const files = [];
  async function walk(folder) {
    for (const item of await readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, item.name);
      if (item.isDirectory()) await walk(file);
      else if (item.isFile()) {
        const hash = createHash('sha256'); let size = 0;
        for await (const chunk of createReadStream(file)) { hash.update(chunk); size += chunk.length; }
        files.push({ path: path.relative(root, file).split(path.sep).join('/'), size, sha256: hash.digest('hex') });
      } else throw new Error('Installer payload contains an unsupported link: ' + file);
    }
  }
  await walk(root);
  return { version: 1, files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}

// Windows resource editing and optional signing happen after afterPack. Hash the
// final executable, not the pre-icon/pre-version binary.
export default async function afterSign(context) {
  if (context.electronPlatformName !== 'win32') return;
  if (context.arch !== 1) throw new Error('Installer staging currently supports only Windows x64');
  const result = await inventory(context.appOutDir);
  const directory = path.join(context.packager.projectDir, 'dist');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'installer-payload.json'), JSON.stringify(result));
}
