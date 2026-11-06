import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicAddress } from '../src/assets.js';
import { parseLessons } from '../src/config.js';
import { renderBlocks, renderRichText, safeExternalUrl } from '../src/render.js';
import { PAGE_ID, richText, testConfig } from './helpers.js';

test('rich text is escaped, formatted, and local Notion mentions are rewritten', () => {
  const config = testConfig();
  const html = renderRichText([
    { ...richText('<script>alert(1)</script>')[0], annotations: { bold: true } },
    { type: 'mention', plain_text: 'Local lesson', mention: { type: 'page', page: { id: PAGE_ID } } },
    ...richText('External', 'https://example.com/lesson'),
  ], { config });
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /<strong>/);
  assert.match(html, /href="\/lessons\/lesson-one"/);
  assert.match(html, /rel="noopener noreferrer external"/);
  assert.match(html, /\(external\)/);
});

test('unsafe and credential-bearing URLs never become links', () => {
  assert.equal(safeExternalUrl('javascript:alert(1)'), null);
  assert.equal(safeExternalUrl('data:text/html,hello'), null);
  assert.equal(safeExternalUrl('https://user:pass@example.com/'), null);
  assert.equal(safeExternalUrl('https://example.com/a'), 'https://example.com/a');
  const html = renderRichText(richText('not a link', 'javascript:alert(1)'), { config: testConfig() });
  assert.doesNotMatch(html, /<a /);
});

test('common blocks render and unsupported blocks remain visible', () => {
  const warnings = [];
  const blocks = [
    { id: '1', type: 'heading_1', heading_1: { rich_text: richText('Heading') } },
    { id: '2', type: 'to_do', to_do: { checked: true, rich_text: richText('Done') } },
    { id: '3', type: 'code', code: { language: 'javascript', rich_text: richText('if (a < b) {}') } },
    { id: '4', type: 'divider', divider: {} },
    { id: '5', type: 'mystery', mystery: {} },
  ];
  const html = renderBlocks(blocks, { config: testConfig(), onUnsupported: (type) => warnings.push(type) });
  assert.match(html, /<h2>Heading<\/h2>/);
  assert.match(html, /disabled checked/);
  assert.match(html, /if \(a &lt; b\)/);
  assert.match(html, /<hr>/);
  assert.match(html, /Unsupported Notion block: mystery/);
  assert.deepEqual(warnings, ['mystery']);
});

test('basic tables and read-only toggles are rendered', () => {
  const html = renderBlocks([
    {
      id: 'table', type: 'table',
      table: { has_column_header: true, has_row_header: false },
      children: [{ id: 'row', type: 'table_row', table_row: { cells: [richText('Name'), richText('Value')] } }],
    },
    { id: 'toggle', type: 'toggle', toggle: { rich_text: richText('More') }, children: [{ id: 'p', type: 'paragraph', paragraph: { rich_text: richText('Nested') } }] },
  ], { config: testConfig() });
  assert.match(html, /<th scope="col">Name<\/th>/);
  assert.match(html, /<details><summary>More<\/summary><p>Nested<\/p><\/details>/);
});

test('configuration rejects duplicate slugs and invalid page IDs', () => {
  const lesson = { slug: 'valid-slug', title: 'Title', pageId: PAGE_ID };
  assert.throws(() => parseLessons([lesson, lesson]), /unique/);
  assert.throws(() => parseLessons([{ ...lesson, pageId: 'not-a-page' }]), /invalid pageId/);
});

test('public IP validation rejects loopback, private, link-local, and IPv4-mapped addresses', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('allowlisted child pages become local links without crawling other child pages', () => {
  const html = renderBlocks([
    { id: PAGE_ID, type: 'child_page', child_page: { title: 'Allowlisted child' } },
    { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', type: 'child_page', child_page: { title: 'Other child' } },
  ], { config: testConfig() });
  assert.match(html, /<a href="\/lessons\/lesson-one">Allowlisted child<\/a>/);
  assert.match(html, /Child page not published: Other child/);
});
