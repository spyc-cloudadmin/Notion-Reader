import assert from 'node:assert/strict';
import { once } from 'node:events';
import { parseLessons } from '../src/config.js';
import { NotionClient } from '../src/notion.js';
import { LessonPublisher } from '../src/publish.js';
import { createApplication } from '../src/server.js';

export const SECRET = 'test-admin-secret-with-at-least-32-characters';
export const NOTION_TOKEN = 'test-notion-token-not-for-production';
export const PAGE_ID = '01234567-89ab-cdef-8123-456789abcdef';

export class MemoryStore {
  constructor() {
    this.objects = new Map();
    this.nextGeneration = 1;
  }

  clone(object) {
    return { ...object, data: Buffer.from(object.data), metadata: { ...object.metadata } };
  }

  async read(path) {
    const object = this.objects.get(path);
    return object ? Buffer.from(object.data) : null;
  }

  async get(path) {
    const object = this.objects.get(path);
    return object ? this.clone(object) : null;
  }

  async readJson(path) {
    const data = await this.read(path);
    return data ? JSON.parse(data.toString('utf8')) : null;
  }

  async write(path, data, options = {}) {
    const existing = this.objects.get(path);
    if (options.ifGenerationMatch !== undefined) {
      const actual = existing?.metadata.generation ?? '0';
      if (String(options.ifGenerationMatch) !== actual) {
        const error = new Error('Precondition failed');
        error.code = 412;
        throw error;
      }
    }
    const generation = String(this.nextGeneration++);
    this.objects.set(path, {
      data: Buffer.from(data),
      metadata: { ...options, generation },
    });
  }

  async metadata(path) {
    return this.objects.get(path)?.metadata ?? null;
  }

  async delete(path, ifGenerationMatch) {
    const existing = this.objects.get(path);
    if (!existing) return;
    if (ifGenerationMatch !== undefined && existing.metadata.generation !== String(ifGenerationMatch)) {
      const error = new Error('Precondition failed');
      error.code = 412;
      throw error;
    }
    this.objects.delete(path);
  }
}

export function testConfig(overrides = {}) {
  return {
    ...parseLessons([{ slug: 'lesson-one', title: 'Lesson One', pageId: PAGE_ID }]),
    notionToken: NOTION_TOKEN,
    adminToken: SECRET,
    bucket: 'test-bucket',
    notionVersion: '2026-03-11',
    publishTimeoutMs: 10_000,
    lockTtlMs: 30_000,
    recursivePublish: false,
    refreshOnStart: false,
    maxTreePages: 50,
    maxTreeDepth: 8,
    maxBlocks: 1_000,
    maxRenderedBytes: 2_000_000,
    maxAssetBytes: 1_000_000,
    maxTotalAssetBytes: 5_000_000,
    assetTimeoutMs: 1_000,
    assetAllowedHosts: new Set(['file.notion.so']),
    maxNotionRetries: 0,
    ...overrides,
  };
}

export const quietLogger = { info() {}, warn() {}, error() {} };

export async function runningApp({ config = testConfig(), store = new MemoryStore(), notion, publisher, fetchImpl } = {}) {
  const notionClient = notion ?? new NotionClient(config, { fetchImpl, logger: quietLogger, random: () => 0 });
  const lessonPublisher = publisher ?? new LessonPublisher(config, store, notionClient, { logger: quietLogger });
  const server = createApplication({ config, store, publisher: lessonPublisher, logger: quietLogger });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    server,
    store,
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}

export async function publish(baseUrl, slug = 'lesson-one') {
  return fetch(`${baseUrl}/admin/publish/${slug}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}` },
  });
}

export function richText(content, link) {
  return [{
    type: 'text',
    plain_text: content,
    text: { content, ...(link ? { link: { url: link } } : {}) },
    ...(link ? { href: link } : {}),
    annotations: {},
  }];
}

export function assertNoSecrets(value) {
  assert.equal(value.includes(SECRET), false);
  assert.equal(value.includes(NOTION_TOKEN), false);
}
