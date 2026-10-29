import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { petStatuses } from '../src/shared/pet';

const read = (file: string) => readFileSync(file);
const json = (file: string) => JSON.parse(read(file).toString('utf8'));
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('bundled illustrated pet preserves transparent 24 fps clips, bounded size and source digests', () => {
  const source = json('assets/pet/source.json'), report = json('src/renderer/pet-assets/provenance.json');
  assert.equal(report.importCommit, source.commit);
  assert.equal(report.sourceFps, 24); assert.equal(report.format, 'animated-webp');
  for (const status of petStatuses) {
    const record = report.states[status], selection = source.states[status];
    assert.equal(record.clip, selection.clip);
    const bytes = read('src/renderer/pet-assets/' + status + '.webp');
    assert.equal(digest(bytes), record.animationSha256);
    assert.ok(bytes.length < 4 * 1024 * 1024);
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF'); assert.equal(bytes.toString('ascii', 8, 12), 'WEBP');
    assert.equal(bytes.readUInt32LE(4), bytes.length - 8);
    let loop = -1, count = 0, elapsed = 0, alpha = false, width = 0, height = 0;
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const name = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4);
      assert.ok(offset + 8 + size <= bytes.length);
      const chunk = bytes.subarray(offset + 8, offset + 8 + size);
      if (name === 'VP8X') { alpha = !!(chunk[0] & 16); width = chunk.readUIntLE(4, 3) + 1; height = chunk.readUIntLE(7, 3) + 1; }
      if (name === 'ANIM') loop = chunk.readUInt16LE(4);
      if (name === 'ANMF') { count++; elapsed += chunk.readUIntLE(12, 3); }
      offset += 8 + size + (size & 1);
    }
    assert.equal(alpha, true); assert.deepEqual([width, height], source.canvas);
    assert.equal(loop, selection.loop ? 0 : 1);
    assert.ok(count >= 24 && count <= record.sourceFrames);
    assert.ok(Math.abs(elapsed - record.sourceFrames * 1000 / 24) <= 2);
    const poster = read('src/renderer/pet-assets/' + status + '.png');
    assert.equal(digest(poster), record.posterSha256);
    assert.equal(poster.toString('hex', 0, 8), '89504e470d0a1a0a');
    assert.deepEqual([poster.readUInt32BE(16), poster.readUInt32BE(20)], source.canvas);
    assert.equal(poster[25], 6, 'Poster retains RGBA transparency');
  }
});

test('default-art redistribution includes both MIT notices in the installed application', () => {
  assert.match(read('assets/pet/LICENSE-PC2005-cloud.txt').toString(), /Copyright \(c\) 2026 PC2005-cloud/);
  assert.match(read('assets/pet/LICENSE-QCYTSN.txt').toString(), /Copyright \(c\) 2026 QCYTSN/);
  const pkg = json('package.json');
  assert.ok(pkg.build.extraResources.some((entry: {from: string; to: string}) => entry.from === 'assets/pet' && entry.to === 'assets/pet'));
});
