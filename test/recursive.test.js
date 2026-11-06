import test from 'node:test';
import assert from 'node:assert/strict';
import { NotionClient } from '../src/notion.js';
import { LessonPublisher, paths } from '../src/publish.js';
import {
  MemoryStore, NOTION_TOKEN, PAGE_ID, publish, quietLogger, richText, runningApp, testConfig,
} from './helpers.js';

const CHILD_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const GRANDCHILD_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function treeNotion(state, calls) {
  return async (url, options) => {
    calls.push(url);
    assert.equal(options.headers.Authorization, `Bearer ${NOTION_TOKEN}`);
    const parsed = new URL(url);
    const pageId = [PAGE_ID, CHILD_ID, GRANDCHILD_ID].find((id) => parsed.pathname === `/v1/pages/${id}`);
    if (pageId) {
      if (state.failGrandchild && pageId === GRANDCHILD_ID) return Response.json({}, { status: 500 });
      return Response.json({ object: 'page', id: pageId });
    }
    const blocksId = [PAGE_ID, CHILD_ID, GRANDCHILD_ID].find((id) => parsed.pathname === `/v1/blocks/${id}/children`);
    const empty = { object: 'list', has_more: false, next_cursor: null };
    if (blocksId === PAGE_ID) return Response.json({ ...empty, results: [
      { object: 'block', id: 'root-text', type: 'paragraph', has_children: false, paragraph: { rich_text: richText(state.rootText) } },
      { object: 'block', id: CHILD_ID, type: 'child_page', has_children: false, child_page: { title: 'Child Lesson' } },
    ] });
    if (blocksId === CHILD_ID) return Response.json({ ...empty, results: [
      { object: 'block', id: GRANDCHILD_ID, type: 'child_page', has_children: false, child_page: { title: 'Grandchild Lesson' } },
      { object: 'block', id: 'child-image', type: 'image', has_children: false, image: { type: 'file', file: { url: 'https://file.notion.so/tree.png' }, caption: [] } },
    ] });
    if (blocksId === GRANDCHILD_ID) return Response.json({ ...empty, results: [
      { object: 'block', id: 'grandchild-text', type: 'paragraph', has_children: false, paragraph: { rich_text: richText('Grandchild content') } },
    ] });
    throw new Error(`Unexpected Notion request: ${url}`);
  };
}

test('recursive publishing discovers descendants, serves dynamic routes, and rolls back tree failures', async (t) => {
  const state = { rootText: 'Original root' };
  const calls = [];
  const config = testConfig({ recursivePublish: true });
  const store = new MemoryStore();
  const notion = new NotionClient(config, { fetchImpl: treeNotion(state, calls), logger: quietLogger });
  const publisher = new LessonPublisher(config, store, notion, {
    logger: quietLogger,
    assetDownloader: async () => ({ data: Buffer.from('tree-image'), contentType: 'image/png' }),
  });
  const app = await runningApp({ config, store, notion, publisher });
  t.after(app.close);

  let response = await publish(app.baseUrl);
  assert.equal(response.status, 200);
  const published = await response.json();
  assert.equal(published.pages, 3);
  assert.equal(calls.length, 6);
  const current = await store.readJson(paths.current('lesson-one'));
  assert.equal(current.pages.length, 3);

  response = await fetch(`${app.baseUrl}/lessons/lesson-one`);
  assert.match(await response.text(), /href="\/lessons\/child-lesson-aaaaaaaa"/);
  response = await fetch(`${app.baseUrl}/lessons/child-lesson-aaaaaaaa`);
  const childHtml = await response.text();
  assert.match(childHtml, /href="\/lessons\/grandchild-lesson-bbbbbbbb"/);
  const assetPath = childHtml.match(/src="(\/assets\/[^"]+)"/)?.[1];
  assert.ok(assetPath);
  response = await fetch(`${app.baseUrl}/lessons/grandchild-lesson-bbbbbbbb`);
  assert.match(await response.text(), /Grandchild content/);
  response = await fetch(`${app.baseUrl}${assetPath}`);
  assert.equal(await response.text(), 'tree-image');
  assert.equal(calls.length, 6);

  state.rootText = 'Should not become current';
  state.failGrandchild = true;
  response = await publish(app.baseUrl);
  assert.equal(response.status, 502);
  assert.equal((await store.readJson(paths.current('lesson-one'))).version, published.version);
  response = await fetch(`${app.baseUrl}/lessons/lesson-one`);
  assert.match(await response.text(), /Original root/);
});
