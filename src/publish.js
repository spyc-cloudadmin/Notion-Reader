import { randomUUID } from 'node:crypto';
import { assetLocation, assetSource, downloadAsset } from './assets.js';
import { HttpError } from './errors.js';
import { renderLesson } from './render.js';

export const paths = {
  lock: (slug) => `lessons/${slug}/publish-lock.json`,
  current: (slug) => `lessons/${slug}/current.json`,
  snapshot: (slug, version) => `lessons/${slug}/versions/${version}/index.html`,
  asset: (slug, version, filename) => `lessons/${slug}/versions/${version}/assets/${filename}`,
};

function isPreconditionFailure(error) {
  return error.code === 412 || error.statusCode === 412;
}

function normalizedPageId(pageId) {
  return pageId.replaceAll('-', '').toLowerCase();
}

function descendantSlug(title, pageId) {
  const base = title.normalize('NFKD').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 55).replace(/-$/g, '') || 'lesson';
  return `${base}-${normalizedPageId(pageId).slice(0, 8)}`;
}

function childPages(blocks = []) {
  const children = [];
  for (const block of blocks) {
    if (block.type === 'child_page') children.push({ pageId: block.id, title: block.child_page?.title || 'Untitled lesson' });
    if (!['child_page', 'link_to_page'].includes(block.type)) children.push(...childPages(block.children));
  }
  return children;
}

export class LessonPublisher {
  constructor(config, store, notion, {
    logger = console,
    uuid = randomUUID,
    now = () => new Date(),
    assetDownloader = downloadAsset,
  } = {}) {
    this.config = config;
    this.store = store;
    this.notion = notion;
    this.logger = logger;
    this.uuid = uuid;
    this.now = now;
    this.assetDownloader = assetDownloader;
  }

  async acquireLock(slug, publishId) {
    const path = paths.lock(slug);
    const value = JSON.stringify({ owner: publishId, expiresAt: this.now().getTime() + this.config.lockTtlMs });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.store.write(path, value, { contentType: 'application/json', ifGenerationMatch: 0 });
        const metadata = await this.store.metadata(path);
        return { path, generation: metadata.generation };
      } catch (error) {
        if (!isPreconditionFailure(error)) throw error;
        const [lock, metadata] = await Promise.all([this.store.readJson(path), this.store.metadata(path)]);
        if (!lock || !metadata || Number(lock.expiresAt) > this.now().getTime()) return false;
        await this.store.delete(path, metadata.generation);
      }
    }
    return false;
  }

  async releaseLock(lock) {
    if (!lock) return;
    try {
      await this.store.delete(lock.path, lock.generation);
    } catch (error) {
      this.logger.warn({ event: 'publish_lock_release_failed', code: error.code ?? 'storage_error' });
    }
  }

  async mirrorAssets(blocks, slug, version, deadline, assets, totals) {
    for (const block of blocks) {
      if (Date.now() >= deadline) throw new HttpError(504, 'Publishing deadline exceeded', 'publish_timeout');
      const source = assetSource(block);
      if (source) {
        try {
          const downloaded = await this.assetDownloader(source, {
            allowedHosts: this.config.assetAllowedHosts,
            maxBytes: this.config.maxAssetBytes,
            timeoutMs: this.config.assetTimeoutMs,
          });
          if (totals.bytes + downloaded.data.length > this.config.maxTotalAssetBytes) {
            throw new HttpError(422, 'Lesson assets exceed the total size limit', 'assets_too_large');
          }
          const location = assetLocation(source, block, downloaded, block.type === 'image' ? 'image' : 'file');
          await this.store.write(paths.asset(slug, version, location.filename), downloaded.data, {
            contentType: location.contentType,
            cacheControl: 'public, max-age=31536000, immutable',
            contentDisposition: location.contentDisposition,
          });
          totals.bytes += downloaded.data.length;
          assets.set(block.id, { url: `/assets/${slug}/${version}/${location.filename}` });
        } catch (error) {
          if (!error.code?.startsWith?.('asset_') && !['invalid_asset_url', 'asset_host_denied', 'unsupported_image_type', 'assets_too_large'].includes(error.code)) {
            throw error;
          }
          assets.set(block.id, { error: error.message });
          totals.warnings += 1;
          this.logger.warn({ event: 'asset_mirrored_failed', blockType: block.type, code: error.code });
        }
      }
      if (block.children) await this.mirrorAssets(block.children, slug, version, deadline, assets, totals);
    }
  }

  async discoverTree(root, deadline) {
    const pages = [];
    const byPageId = new Map();
    const visit = async (lesson, depth) => {
      if (depth > this.config.maxTreeDepth) {
        throw new HttpError(413, 'Lesson tree exceeds the depth limit', 'content_limit');
      }
      const key = normalizedPageId(lesson.pageId);
      if (byPageId.has(key)) return;
      if (pages.length >= this.config.maxTreePages) {
        throw new HttpError(413, 'Lesson tree exceeds the page limit', 'content_limit');
      }
      const entry = depth === 0 ? root : {
        slug: descendantSlug(lesson.title, lesson.pageId),
        title: lesson.title,
        pageId: lesson.pageId,
      };
      byPageId.set(key, entry.slug);
      pages.push(entry);
      entry.blocks = await this.notion.lesson(entry.pageId, deadline);
      for (const child of childPages(entry.blocks)) await visit(child, depth + 1);
    };
    await visit(root, 0);
    return { pages, byPageId };
  }

  async switchCurrent(slug, pointer) {
    const path = paths.current(slug);
    const metadata = await this.store.metadata(path);
    await this.store.write(path, JSON.stringify(pointer), {
      contentType: 'application/json',
      cacheControl: 'no-store',
      ifGenerationMatch: metadata?.generation ?? 0,
    });
  }

  async publish(slug, requestedPublishId) {
    const lesson = this.config.bySlug.get(slug);
    if (!lesson) throw new HttpError(404, 'Unknown lesson', 'unknown_lesson');
    const publishId = requestedPublishId ?? this.uuid();
    const log = {
      info: (entry) => this.logger.info({ ...entry, publishId }),
      warn: (entry) => this.logger.warn({ ...entry, publishId }),
      error: (entry) => this.logger.error({ ...entry, publishId }),
    };
    const deadline = Date.now() + this.config.publishTimeoutMs;
    log.info({ event: 'publish_started', slug, recursive: this.config.recursivePublish });
    const lock = await this.acquireLock(slug, publishId);
    if (!lock) {
      log.warn({ event: 'publish_rejected_locked', slug });
      throw new HttpError(409, 'A publish is already running for this lesson', 'publish_locked');
    }

    try {
      const tree = this.config.recursivePublish
        ? await this.discoverTree(lesson, deadline)
        : { pages: [{ ...lesson, blocks: await this.notion.lesson(lesson.pageId, deadline) }], byPageId: this.config.byPageId };
      const renderConfig = {
        ...this.config,
        byPageId: new Map([...this.config.byPageId, ...tree.byPageId]),
      };
      const totals = { bytes: 0, warnings: 0 };
      const publishedAt = this.now().toISOString();

      for (const page of tree.pages) {
        const assets = new Map();
        await this.mirrorAssets(page.blocks, page.slug, publishId, deadline, assets, totals);
        const html = renderLesson({
          lesson: page,
          blocks: page.blocks,
          assets,
          publishedAt,
          config: renderConfig,
          onUnsupported: (type) => log.warn({ event: 'unsupported_block', blockType: type, slug: page.slug }),
        });
        if (Buffer.byteLength(html) > this.config.maxRenderedBytes) {
          throw new HttpError(413, 'Rendered lesson exceeds the size limit', 'content_limit');
        }
        await this.store.write(paths.snapshot(page.slug, publishId), html, {
          contentType: 'text/html; charset=utf-8',
          cacheControl: 'no-cache',
        });
      }

      const pages = tree.pages.map(({ slug: pageSlug, title, pageId }) => ({ slug: pageSlug, title, pageId }));
      await this.switchCurrent(slug, { version: publishId, publishedAt, pages });
      log.info({ event: 'publish_succeeded', slug, version: publishId, pages: pages.length, warnings: totals.warnings });
      return { ok: true, slug, version: publishId, publishedAt, pages: pages.length, warnings: totals.warnings };
    } catch (error) {
      log.error({ event: 'publish_failed', slug, code: error.code ?? 'internal_error', status: error.status ?? 500 });
      throw error;
    } finally {
      await this.releaseLock(lock);
    }
  }
}
