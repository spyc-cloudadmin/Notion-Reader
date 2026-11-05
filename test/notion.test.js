import test from 'node:test';
import assert from 'node:assert/strict';
import { NotionClient } from '../src/notion.js';
import { quietLogger, testConfig } from './helpers.js';

test('Notion rate limits respect Retry-After and use bounded retries', async () => {
  const waits = [];
  let calls = 0;
  const client = new NotionClient(testConfig({ maxNotionRetries: 2 }), {
    logger: quietLogger,
    random: () => 0,
    sleepImpl: async (milliseconds) => waits.push(milliseconds),
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? Response.json({}, { status: 429, headers: { 'Retry-After': '2' } })
        : Response.json({ object: 'list', results: [], has_more: false, next_cursor: null });
    },
  });
  const result = await client.request('/blocks/page/children', Date.now() + 10_000);
  assert.equal(result.object, 'list');
  assert.equal(calls, 2);
  assert.deepEqual(waits, [2000]);
});
