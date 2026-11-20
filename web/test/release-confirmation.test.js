import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios, runScenario, sampleReleaseLatency } from '../validation/p1.4-f-cases.mjs';

for (const scenario of scenarios) test(`P1.4-F: ${scenario.name}`, () => runScenario(scenario));

test('P1.4-F: sustained release delay is window plus sampling quantization at 80/60/30 Hz', () => {
  assert.equal(sampleReleaseLatency(undefined, 12.5), 50);
  assert.ok(Math.abs(sampleReleaseLatency(undefined, 1000 / 60) - 50) < 1e-10);
  assert.ok(Math.abs(sampleReleaseLatency(undefined, 1000 / 30) - 2000 / 30) < 1e-10);
});
