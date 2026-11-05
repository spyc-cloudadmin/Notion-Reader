import test from 'node:test';
import assert from 'node:assert/strict';
import { NotionClient } from '../src/notion.js';
import { LessonPublisher } from '../src/publish.js';
import { paths } from '../src/publish.js';
import {
  MemoryStore, NOTION_TOKEN, PAGE_ID, assertNoSecrets, publish, quietLogger, richText, runningApp, testConfig,
} from './helpers.js';

function fakeNotion(state, calls) {
  return async (url, options) => {
    calls.push(url);
    assert.equal(options.headers.Authorization, `Bearer ${NOTION_TOKEN}`);
    assert.equal(options.headers['Notion-Version'], '2026-03-11');
    if (state.fail) return Response.json({ object: 'error' }, { status: 500 });
    if (state.delay) await new Promise((resolve) => setTimeout(resolve, state.delay));
    const parsed = new URL(url);
    if (parsed.pathname === `/v1/pages/${PAGE_ID}`) return Response.json({ object: 'page', id: PAGE_ID });
    if (parsed.pathname === `/v1/blocks/${PAGE_ID}/children`) {
      if (parsed.searchParams.get('start_cursor') === 'second-page') {
        return Response.json({ object: 'list', has_more: false, next_cursor: null, results: [
          { object: 'block', id: 'last', type: 'paragraph', has_children: false, paragraph: { rich_text: richText('After pagination') } },
        ] });
      }
      return Response.json({ object: 'list', has_more: true, next_cursor: 'second-page', results: [
        { object: 'block', id: 'text', type: 'paragraph', has_children: false, paragraph: { rich_text: richText(state.text) } },
        { object: 'block', id: 'toggle', type: 'toggle', has_children: true, toggle: { rich_text: richText('Nested section') } },
        { object: 'block', id: 'image', type: 'image', has_children: false, image: { type: 'file', file: { url: 'https://file.notion.so/image.png?expires=soon' }, caption: [] } },
      ] });
    }
    if (parsed.pathname === '/v1/blocks/toggle/children') {
      return Response.json({ object: 'list', has_more: false, next_cursor: null, results: [
        { object: 'block', id: 'nested', type: 'paragraph', has_children: false, paragraph: { rich_text: richText('Deeply nested content') } },
      ] });
    }
    throw new Error(`Unexpected Notion URL: ${url}`);
  };
}

test('end-to-end publication is cached, versioned, restart-safe, and rollback-safe', async (t) => {
  const state = { text: 'Original lesson' };
  const calls = [];
  const store = new MemoryStore();
  const config = testConfig();
  const notion = new NotionClient(config, { fetchImpl: fakeNotion(state, calls), logger: quietLogger });
  const publisher = new LessonPublisher(config, store, notion, {
    logger: quietLogger,
    assetDownloader: async () => ({ data: Buffer.from('persistent-image-bytes'), contentType: 'image/png' }),
  });
  let app = await runningApp({ config, store, notion, publisher });
  t.after(() => app.close());

  let response = await publish(app.baseUrl);
  assert.equal(response.status, 200);
  const firstPublish = await response.json();
  assert.equal(firstPublish.ok, true);
  assert.equal(calls.length, 4);
  response = await fetch(`${app.baseUrl}/lessons/lesson-one`);
  const originalHtml = await response.text();
  assert.match(originalHtml, /Original lesson/);
  assert.match(originalHtml, /Deeply nested content/);
  assert.match(originalHtml, /After pagination/);
  assert.match(originalHtml, /Last successfully published/);
  const assetPath = originalHtml.match(/src="(\/assets\/[^"]+)"/)?.[1];
  assert.ok(assetPath);
  assertNoSecrets(originalHtml);

  const callsAfterPublish = calls.length;
  const visits = await Promise.all(Array.from({ length: 12 }, () => fetch(`${app.baseUrl}/lessons/lesson-one`)));
  assert.ok(visits.every((visit) => visit.status === 200));
  assert.equal(calls.length, callsAfterPublish);
  response = await fetch(`${app.baseUrl}${assetPath}`);
  assert.equal(await response.text(), 'persistent-image-bytes');
  assert.match(response.headers.get('cache-control'), /immutable/);
  assert.equal(calls.length, callsAfterPublish);

  state.text = 'Edited but unpublished';
  response = await fetch(`${app.baseUrl}/lessons/lesson-one`);
  assert.match(await response.text(), /Original lesson/);
  assert.equal(calls.length, callsAfterPublish);

  response = await publish(app.baseUrl);
  assert.equal(response.status, 200);
  const secondPublish = await response.json();
  assert.notEqual(firstPublish.version, secondPublish.version);
  response = await fetch(`${app.baseUrl}/lessons/lesson-one`);
  assert.match(await response.text(), /Edited but unpublished/);

  state.fail = true;
  response = await publish(app.baseUrl);
  assert.equal(response.status, 502);
  response = await fetch(`${app.baseUrl}/lessons/lesson-one`);
  assert.match(await response.text(), /Edited but unpublished/);
  assert.equal((await store.readJson(paths.current('lesson-one'))).version, secondPublish.version);

  await app.close();
  const restartedNotion = new NotionClient(config, { fetchImpl: async () => { throw new Error('Notion called after restart'); }, logger: quietLogger });
  app = await runningApp({ config, store, notion: restartedNotion });
  response = await fetch(`${app.baseUrl}/lessons/lesson-one`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Edited but unpublished/);

  const conditional = await fetch(`${app.baseUrl}/lessons/lesson-one`, { headers: { 'If-None-Match': `"${secondPublish.version}"` } });
  assert.equal(conditional.status, 304);
});

test('simultaneous publishes cannot corrupt or partially switch a lesson', async (t) => {
  const state = { text: 'Concurrent lesson', delay: 50 };
  const calls = [];
  const config = testConfig();
  const store = new MemoryStore();
  const notion = new NotionClient(config, { fetchImpl: fakeNotion(state, calls), logger: quietLogger });
  const publisher = new LessonPublisher(config, store, notion, {
    logger: quietLogger,
    assetDownloader: async () => ({ data: Buffer.from('image'), contentType: 'image/png' }),
  });
  const app = await runningApp({ config, store, notion, publisher });
  t.after(app.close);

  const results = await Promise.all([publish(app.baseUrl), publish(app.baseUrl)]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  const current = await store.readJson(paths.current('lesson-one'));
  const snapshot = await store.read(paths.snapshot('lesson-one', current.version));
  assert.match(snapshot.toString(), /Concurrent lesson/);
  const response = await fetch(`${app.baseUrl}/lessons/lesson-one`);
  assert.match(await response.text(), /Concurrent lesson/);
  assert.equal(await store.read(paths.lock('lesson-one')), null);
});
