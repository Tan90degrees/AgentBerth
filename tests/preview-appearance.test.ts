import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPreviewAppearance, normalizePreviewAppearance, previewFontFamily } from '../src/shared/preview-appearance';

test('saved preview typography validates size and font without affecting terminal settings', () => {
  assert.deepEqual(normalizePreviewAppearance(null), defaultPreviewAppearance);
  assert.equal(normalizePreviewAppearance({ size: 100 }).size, 28);
  assert.equal(normalizePreviewAppearance({ size: -1 }).size, 10);
  assert.equal(normalizePreviewAppearance({ size: NaN, font: 'unknown' }).font, 'auto');
  assert.equal(normalizePreviewAppearance({ size: NaN }).size, 13);
  const custom = normalizePreviewAppearance({ size: 17, font: 'custom', customFont: 'Sarasa Mono SC' });
  assert.equal(previewFontFamily(custom), '"Sarasa Mono SC", monospace');
  assert.equal(normalizePreviewAppearance({ customFont: 'a\nb' }).customFont, 'ab');
});
