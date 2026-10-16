// Runs with the staged Electron's embedded Node before changing the old install.
// Hash the physical app.asar archive; Electron otherwise exposes it as a directory.
process.noAsar = true;
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

async function verify(root, manifestFile) {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 20000) throw new Error('Invalid installer inventory');
  const seen = new Set();
  let bytes = 0;
  for (const item of manifest.files) {
    if (typeof item.path !== 'string' || !item.path || item.path.split(/[\\/]/).some(p => !p || p === '.' || p === '..') || /[:\x00]/.test(item.path) || !Number.isSafeInteger(item.size) || item.size < 0 || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('Invalid inventory entry');
    const key = item.path.toLowerCase();
    if (seen.has(key)) throw new Error('Duplicate inventory path');
    seen.add(key);
    const file = path.join(root, item.path);
    if (!fs.statSync(file).isFile()) throw new Error('Missing payload file: ' + item.path);
    const hash = crypto.createHash('sha256'); let size = 0;
    for await (const chunk of fs.createReadStream(file)) { hash.update(chunk); size += chunk.length; }
    if (size !== item.size || hash.digest('hex') !== item.sha256) throw new Error('Payload verification failed: ' + item.path);
    bytes += size;
  }
  return { files: seen.size, bytes };
}
module.exports = { verify };
if (require.main === module) verify(process.argv[2], process.argv[3]).then(result => console.log(`VERIFIED: ${result.files} files, ${result.bytes} bytes`)).catch(error => { console.error(error.message); process.exitCode = 1; });
