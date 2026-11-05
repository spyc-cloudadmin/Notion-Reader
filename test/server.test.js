import test from 'node:test';
import assert from 'node:assert/strict';
import { SECRET, assertNoSecrets, publish, runningApp } from './helpers.js';

test('health, index, and unpublished lessons do not call Notion', async (t) => {
  let notionCalls = 0;
  const app = await runningApp({ fetchImpl: async () => { notionCalls += 1; throw new Error('unexpected'); } });
  t.after(app.close);

  const health = await fetch(`${app.baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  const index = await fetch(`${app.baseUrl}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /Lesson One/);
  const lesson = await fetch(`${app.baseUrl}/lessons/lesson-one`);
  assert.equal(lesson.status, 404);
  assert.match(await lesson.text(), /has not been published/);
  assert.equal(notionCalls, 0);
});

test('publish requires bearer authentication and rejects unknown slugs', async (t) => {
  const app = await runningApp({ fetchImpl: async () => { throw new Error('Notion must not be called'); } });
  t.after(app.close);

  const missing = await fetch(`${app.baseUrl}/admin/publish/lesson-one`, { method: 'POST' });
  assert.equal(missing.status, 401);
  const wrong = await fetch(`${app.baseUrl}/admin/publish/lesson-one`, { method: 'POST', headers: { Authorization: 'Bearer wrong-secret-that-is-long-enough-000' } });
  assert.equal(wrong.status, 401);
  const unknown = await publish(app.baseUrl, 'unknown');
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error, 'Unknown lesson');
  assertNoSecrets(await wrong.text());
});

test('student routes return no credentials and use revalidation', async (t) => {
  const app = await runningApp();
  t.after(app.close);
  for (const path of ['/', '/lessons/unknown', '/healthz']) {
    const response = await fetch(`${app.baseUrl}${path}`);
    assertNoSecrets(await response.text());
  }
  const index = await fetch(`${app.baseUrl}/`);
  assert.equal(index.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
  assert.match(index.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(SECRET.length >= 32, true);
});
