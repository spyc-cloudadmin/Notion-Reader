import { readFile } from 'node:fs/promises';

const DEFAULT_ASSET_HOSTS = [
  'file.notion.so',
  'prod-files-secure.s3.amazonaws.com',
  'prod-files-secure.s3.us-west-2.amazonaws.com',
];

function integer(value, fallback, minimum, maximum) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Expected an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function normalizePageId(value) {
  if (typeof value !== 'string') return null;
  const compact = value.toLowerCase().replaceAll('-', '');
  if (!/^[0-9a-f]{32}$/.test(compact)) return null;
  return compact;
}

export function parseLessons(value) {
  const lessons = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(lessons) || lessons.length === 0 || lessons.length > 500) {
    throw new Error('LESSONS_JSON must contain 1 to 500 lessons');
  }

  const slugs = new Set();
  const pageIds = new Set();
  const bySlug = new Map();
  const byPageId = new Map();

  for (const lesson of lessons) {
    if (!lesson || !/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(lesson.slug)) {
      throw new Error('Each lesson slug must be 2-64 lowercase letters, digits, or hyphens');
    }
    if (typeof lesson.title !== 'string' || !lesson.title.trim() || lesson.title.length > 200) {
      throw new Error(`Lesson ${lesson.slug} needs a title of 1-200 characters`);
    }
    const normalizedPageId = normalizePageId(lesson.pageId);
    if (!normalizedPageId) throw new Error(`Lesson ${lesson.slug} has an invalid pageId`);
    if (slugs.has(lesson.slug) || pageIds.has(normalizedPageId)) {
      throw new Error('Lesson slugs and page IDs must be unique');
    }
    const entry = { slug: lesson.slug, title: lesson.title.trim(), pageId: lesson.pageId };
    slugs.add(lesson.slug);
    pageIds.add(normalizedPageId);
    bySlug.set(lesson.slug, entry);
    byPageId.set(normalizedPageId, lesson.slug);
  }

  return { lessons: [...bySlug.values()], bySlug, byPageId };
}

export async function loadConfig(env = process.env) {
  const source = env.LESSONS_JSON ?? await readFile(env.LESSONS_CONFIG ?? './lessons.json', 'utf8');
  const lessonConfig = parseLessons(source);
  if (!env.NOTION_TOKEN) throw new Error('NOTION_TOKEN is required');
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32) {
    throw new Error('ADMIN_TOKEN must contain at least 32 characters');
  }
  if (!env.GCS_BUCKET) throw new Error('GCS_BUCKET is required');

  const assetHosts = (env.ASSET_ALLOWED_HOSTS ?? DEFAULT_ASSET_HOSTS.join(','))
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  if (assetHosts.some((host) => !/^(?:[a-z0-9-]+\.)+[a-z0-9-]+$/.test(host))) {
    throw new Error('ASSET_ALLOWED_HOSTS must be a comma-separated list of DNS names');
  }

  const publishTimeoutMs = integer(env.PUBLISH_TIMEOUT_MS, 240_000, 10_000, 270_000);
  const lockTtlMs = integer(env.LOCK_TTL_MS, 300_000, 30_000, 600_000);
  if (lockTtlMs <= publishTimeoutMs + 10_000) {
    throw new Error('LOCK_TTL_MS must exceed PUBLISH_TIMEOUT_MS by more than 10 seconds');
  }

  return {
    ...lessonConfig,
    notionToken: env.NOTION_TOKEN,
    adminToken: env.ADMIN_TOKEN,
    bucket: env.GCS_BUCKET,
    port: integer(env.PORT, 8080, 1, 65535),
    notionVersion: '2026-03-11',
    publishTimeoutMs,
    lockTtlMs,
    maxBlocks: integer(env.MAX_BLOCKS, 1_000, 1, 5_000),
    maxRenderedBytes: integer(env.MAX_RENDERED_BYTES, 2_000_000, 10_000, 10_000_000),
    maxAssetBytes: integer(env.MAX_ASSET_BYTES, 10_000_000, 1_024, 50_000_000),
    maxTotalAssetBytes: integer(env.MAX_TOTAL_ASSET_BYTES, 50_000_000, 1_024, 200_000_000),
    assetTimeoutMs: integer(env.ASSET_TIMEOUT_MS, 10_000, 1_000, 30_000),
    assetAllowedHosts: new Set(assetHosts),
    maxNotionRetries: integer(env.NOTION_MAX_RETRIES, 5, 0, 8),
  };
}
