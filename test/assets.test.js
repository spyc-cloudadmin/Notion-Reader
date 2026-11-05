import test from 'node:test';
import assert from 'node:assert/strict';
import { assetLocation, downloadAsset } from '../src/assets.js';

test('asset downloads reject non-allowlisted and non-HTTPS sources before DNS', async () => {
  for (const url of ['http://file.notion.so/a.png', 'https://example.com/a.png', 'https://file.notion.so:8443/a.png', 'javascript:alert(1)']) {
    await assert.rejects(downloadAsset(url, { allowedHosts: new Set(['file.notion.so']), maxBytes: 100, timeoutMs: 100 }));
  }
});

test('active image formats are not served inline and downloads are attachments', () => {
  const block = { id: 'image', type: 'image', image: {} };
  assert.throws(() => assetLocation('https://file.notion.so/a.svg', block, { contentType: 'image/svg+xml' }, 'image'), /not safe/);
  const file = { id: 'file', type: 'file', file: { name: 'notes.html' } };
  const location = assetLocation('https://file.notion.so/notes', file, { contentType: 'text/html' }, 'file');
  assert.match(location.contentDisposition, /^attachment;/);
  assert.match(location.contentDisposition, /notes.html.bin/);
});
