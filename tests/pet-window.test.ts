import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserWindow } from 'electron';
import { keepPetAboveWindows } from '../src/main/pet-window';

test('pet stacking preserves hidden/minimized/disabled choices and never activates a window', () => {
  const calls: unknown[] = [];
  let destroyed = false, visible = true, minimized = false;
  const target = {
    isDestroyed: () => destroyed, isVisible: () => visible, isMinimized: () => minimized,
    setAlwaysOnTop: (...args: unknown[]) => calls.push(args), moveTop: () => calls.push('raise'),
    show: () => assert.fail('stacking must not show a hidden pet'),
    showInactive: () => assert.fail('stacking must not show a hidden pet'),
    focus: () => assert.fail('stacking must not steal keyboard focus'),
  } as unknown as BrowserWindow;
  keepPetAboveWindows(target, true);
  assert.deepEqual(calls.splice(0), [[true, 'screen-saver'], 'raise']);
  keepPetAboveWindows(target, false);
  assert.deepEqual(calls.splice(0), [[false, 'normal']]);
  visible = false; keepPetAboveWindows(target, true);
  assert.deepEqual(calls.splice(0), [[true, 'screen-saver']]);
  visible = true; minimized = true; keepPetAboveWindows(target, true);
  assert.deepEqual(calls.splice(0), [[true, 'screen-saver']]);
  destroyed = true; keepPetAboveWindows(target, true);
  assert.deepEqual(calls, []);
});
