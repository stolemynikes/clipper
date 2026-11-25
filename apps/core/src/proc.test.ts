import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCmd } from './proc.ts';

test('runCmd kills a stalled program after timeoutMs', async () => {
  const t = Date.now();
  await assert.rejects(runCmd(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 500 }), /timed out/);
  assert.ok(Date.now() - t < 10_000);
});
