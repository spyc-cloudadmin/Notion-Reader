import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as immediate } from 'node:timers/promises';
import { startColdStartRefresh } from '../src/lifecycle.js';
import { quietLogger, testConfig } from './helpers.js';

test('cold-start refresh publishes every configured root once', async () => {
  const calls = [];
  const config = testConfig({ refreshOnStart: true });
  startColdStartRefresh({
    config,
    quietLogger,
    logger: quietLogger,
    publisher: { publish: async (slug) => { calls.push(slug); } },
  });
  await immediate();
  assert.deepEqual(calls, ['lesson-one']);
});

test('cold-start refresh is disabled by default', async () => {
  const calls = [];
  startColdStartRefresh({
    config: testConfig(),
    logger: quietLogger,
    publisher: { publish: async (slug) => { calls.push(slug); } },
  });
  await immediate();
  assert.deepEqual(calls, []);
});
