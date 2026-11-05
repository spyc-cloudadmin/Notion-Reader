import { HttpError } from './errors.js';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class NotionClient {
  constructor(config, { fetchImpl = fetch, logger = console, sleepImpl = sleep, random = Math.random } = {}) {
    this.config = config;
    this.fetch = fetchImpl;
    this.logger = logger;
    this.sleep = sleepImpl;
    this.random = random;
    this.tail = Promise.resolve();
  }

  request(path, deadline) {
    const run = this.tail.then(() => this.requestWithRetry(path, deadline));
    this.tail = run.catch(() => {});
    return run;
  }

  async requestWithRetry(path, deadline) {
    for (let attempt = 0; ; attempt += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new HttpError(504, 'Publishing deadline exceeded', 'publish_timeout');
      let response;
      let body;
      try {
        response = await this.fetch(`https://api.notion.com/v1${path}`, {
          headers: {
            Authorization: `Bearer ${this.config.notionToken}`,
            'Notion-Version': this.config.notionVersion,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(Math.min(15_000, remaining)),
        });
        body = await response.json();
      } catch (error) {
        if (attempt >= this.config.maxNotionRetries || error instanceof HttpError) throw error;
        await this.retryDelay(null, attempt, deadline);
        continue;
      }

      const retryable = response.status === 429
        || response.status === 529
        || [500, 502, 503, 504].includes(response.status);
      const blocked = body?.additional_data?.rate_limit_reason === 'public_api_request_blocked';
      if (retryable && !blocked && attempt < this.config.maxNotionRetries) {
        await this.retryDelay(response.headers.get('retry-after'), attempt, deadline);
        continue;
      }
      if (!response.ok) {
        throw new HttpError(502, `Notion request failed with status ${response.status}`, 'notion_error');
      }
      return body;
    }
  }

  async retryDelay(retryAfter, attempt, deadline) {
    const parsed = Number(retryAfter);
    const baseSeconds = Number.isFinite(parsed) && parsed >= 0
      ? parsed
      : Math.min(2 ** attempt, 30);
    const delay = Math.ceil(baseSeconds * 1000 + this.random() * 250);
    if (Date.now() + delay >= deadline) {
      throw new HttpError(504, 'Notion retry delay exceeds publishing deadline', 'publish_timeout');
    }
    this.logger.info?.({ event: 'notion_retry', attempt: attempt + 1, delayMs: delay });
    await this.sleep(delay);
  }

  async children(blockId, deadline) {
    const results = [];
    const cursors = new Set();
    let cursor = null;
    do {
      if (cursor !== null) {
        if (cursors.has(cursor)) throw new HttpError(502, 'Notion returned a repeated pagination cursor', 'notion_pagination');
        cursors.add(cursor);
      }
      const query = new URLSearchParams({ page_size: '100' });
      if (cursor !== null) query.set('start_cursor', cursor);
      const page = await this.request(`/blocks/${encodeURIComponent(blockId)}/children?${query}`, deadline);
      if (!Array.isArray(page.results)) throw new HttpError(502, 'Invalid Notion block response', 'notion_response');
      results.push(...page.results);
      if (results.length > this.config.maxBlocks) {
        throw new HttpError(413, 'Lesson exceeds the configured block limit', 'content_limit');
      }
      cursor = page.has_more ? page.next_cursor : null;
      if (page.has_more && typeof cursor !== 'string') {
        throw new HttpError(502, 'Notion omitted its pagination cursor', 'notion_pagination');
      }
    } while (cursor !== null);
    return results;
  }

  async fillChildren(blocks, deadline, depth = 0, counter = { count: 0 }) {
    if (depth > 32) throw new HttpError(413, 'Lesson exceeds the nested block depth limit', 'content_limit');
    const output = [];
    for (const block of blocks) {
      counter.count += 1;
      if (counter.count > this.config.maxBlocks) {
        throw new HttpError(413, 'Lesson exceeds the configured block limit', 'content_limit');
      }
      const copy = { ...block };
      if (block.has_children && !['child_page', 'link_to_page'].includes(block.type)) {
        const children = await this.children(block.id, deadline);
        copy.children = await this.fillChildren(children, deadline, depth + 1, counter);
      }
      output.push(copy);
    }
    return output;
  }

  async lesson(pageId, deadline) {
    const page = await this.request(`/pages/${encodeURIComponent(pageId)}`, deadline);
    if (page.object !== 'page') throw new HttpError(502, 'Allowlisted ID is not a Notion page', 'notion_response');
    const blocks = await this.children(pageId, deadline);
    return this.fillChildren(blocks, deadline);
  }
}
