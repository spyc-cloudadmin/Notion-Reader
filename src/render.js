const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}

function textWithBreaks(value) {
  return escapeHtml(value).replaceAll('\n', '<br>');
}

export function safeExternalUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function notionPageIdFromUrl(value) {
  const href = safeExternalUrl(value);
  if (!href) return null;
  const url = new URL(href);
  if (!['notion.so', 'www.notion.so', 'app.notion.com', 'www.notion.site'].includes(url.hostname)) return null;
  const match = url.pathname.match(/(?:^|[^0-9a-f])([0-9a-f]{32})(?:[^0-9a-f]|$)/i)
    ?? url.pathname.match(/([0-9a-f]{8}-[0-9a-f-]{27})/i);
  return match?.[1]?.replaceAll('-', '').toLowerCase() ?? null;
}

function lessonLink(pageId, context) {
  const slug = context.config.byPageId.get(pageId?.replaceAll('-', '').toLowerCase());
  return slug ? `/lessons/${encodeURIComponent(slug)}` : null;
}

function linkTarget(value, context) {
  const local = lessonLink(notionPageIdFromUrl(value), context);
  if (local) return { href: local, external: false };
  const href = safeExternalUrl(value);
  return href ? { href, external: true } : null;
}

function anchor(content, target) {
  if (!target) return content;
  const external = target.external
    ? '<span class="external"> (external)</span><span class="skip"> opens in a new tab</span>'
    : '';
  return `<a href="${escapeHtml(target.href)}"${target.external ? ' target="_blank" rel="noopener noreferrer external"' : ''}>${content}${external}</a>`;
}

export function renderRichText(richText = [], context) {
  return richText.map((item) => {
    let content = textWithBreaks(item.plain_text ?? item.text?.content ?? '');
    const annotations = item.annotations ?? {};
    if (annotations.code) content = `<code>${content}</code>`;
    if (annotations.bold) content = `<strong>${content}</strong>`;
    if (annotations.italic) content = `<em>${content}</em>`;
    if (annotations.strikethrough) content = `<s>${content}</s>`;
    if (annotations.underline) content = `<u>${content}</u>`;
    if (item.type === 'equation') content = `<code>${textWithBreaks(item.equation?.expression ?? item.plain_text)}</code>`;

    let target = null;
    if (item.type === 'mention' && item.mention?.type === 'page') {
      target = { href: lessonLink(item.mention.page.id, context), external: false };
      if (!target.href) target = null;
    } else if (item.href ?? item.text?.link?.url) {
      target = linkTarget(item.href ?? item.text.link.url, context);
    }
    return anchor(content, target);
  }).join('');
}

function placeholder(message) {
  return `<p class="placeholder">${escapeHtml(message)}</p>`;
}

function unsupported(block, context) {
  context.onUnsupported?.(block.type, block.id);
  return placeholder(`Unsupported Notion block: ${block.type}`);
}

function assetFor(block, context) {
  return context.assets?.get(block.id);
}

function renderImage(block, context) {
  const data = block.image ?? {};
  const caption = renderRichText(data.caption, context);
  const asset = assetFor(block, context);
  if (!asset?.url) return placeholder(`Image unavailable: ${asset?.error ?? 'asset was not mirrored'}`);
  return `<figure><img src="${escapeHtml(asset.url)}" alt="${escapeHtml(context.imageAlt(data.caption))}" loading="lazy">${caption ? `<figcaption>${caption}</figcaption>` : ''}</figure>`;
}

function renderFile(block, context, type = 'file') {
  const data = block[type] ?? {};
  const asset = assetFor(block, context);
  const name = data.name || data.caption?.map((item) => item.plain_text).join('') || 'Download file';
  if (!asset?.url) return placeholder(`File unavailable: ${asset?.error ?? 'asset was not mirrored'}`);
  return `<a class="file-link" href="${escapeHtml(asset.url)}" download>${escapeHtml(name)}</a>`;
}

function renderTable(block, context) {
  const rows = block.children ?? [];
  const htmlRows = rows.map((row, rowIndex) => {
    const cells = row.table_row?.cells ?? [];
    const renderedCells = cells.map((cell, columnIndex) => {
      const heading = (block.table?.has_column_header && rowIndex === 0)
        || (block.table?.has_row_header && columnIndex === 0);
      const tag = heading ? 'th' : 'td';
      return `<${tag}${heading ? ' scope="' + (rowIndex === 0 ? 'col' : 'row') + '"' : ''}>${renderRichText(cell, context)}</${tag}>`;
    }).join('');
    return `<tr>${renderedCells}</tr>`;
  }).join('');
  return `<table>${htmlRows}</table>`;
}

function renderBlock(block, context) {
  const data = block[block.type];
  switch (block.type) {
    case 'paragraph':
      return `<p>${renderRichText(data?.rich_text, context)}</p>`;
    case 'heading_1':
    case 'heading_2':
    case 'heading_3':
    case 'heading_4': {
      const level = Math.min(Number(block.type.at(-1)) + 1, 4);
      const content = renderRichText(data?.rich_text, context);
      if (data?.is_toggleable) {
        return `<details><summary>${content}</summary>${renderBlocks(block.children, context)}</details>`;
      }
      return `<h${level}>${content}</h${level}>${renderBlocks(block.children, context)}`;
    }
    case 'bulleted_list_item':
    case 'numbered_list_item':
      return `<li>${renderRichText(data?.rich_text, context)}${renderBlocks(block.children, context)}</li>`;
    case 'to_do':
      return `<div class="todo"><input type="checkbox" disabled${data?.checked ? ' checked' : ''} aria-label="To-do completed"><div>${renderRichText(data?.rich_text, context)}${renderBlocks(block.children, context)}</div></div>`;
    case 'code':
      return `<figure class="code"><figcaption>${escapeHtml(data?.language || 'plain text')}</figcaption><pre><code>${escapeHtml((data?.rich_text ?? []).map((item) => item.plain_text ?? item.text?.content ?? '').join(''))}</code></pre></figure>`;
    case 'quote':
      return `<blockquote><p>${renderRichText(data?.rich_text, context)}</p>${renderBlocks(block.children, context)}</blockquote>`;
    case 'divider':
      return '<hr>';
    case 'callout':
      return `<aside class="callout"><span class="callout-icon" aria-hidden="true">${escapeHtml(data?.icon?.emoji ?? 'ℹ')}</span><div><p>${renderRichText(data?.rich_text, context)}</p>${renderBlocks(block.children, context)}</div></aside>`;
    case 'toggle':
      return `<details><summary>${renderRichText(data?.rich_text, context)}</summary>${renderBlocks(block.children, context)}</details>`;
    case 'table':
      return renderTable(block, context);
    case 'image':
      return renderImage(block, context);
    case 'file':
    case 'pdf':
      return renderFile(block, context);
    case 'embed':
    case 'bookmark':
    case 'video':
    case 'audio': {
      const url = data?.url ?? data?.external?.url ?? data?.file?.url;
      const target = linkTarget(url, context);
      return target
        ? `<p>${anchor(escapeHtml(`${block.type} (open externally)`), target)}</p>`
        : placeholder(`${block.type} has an invalid or unsafe external URL`);
    }
    case 'link_to_page': {
      const local = lessonLink(data?.page_id, context);
      return local
        ? `<p><a href="${escapeHtml(local)}">Linked allowlisted lesson</a></p>`
        : placeholder('Linked page is not allowlisted and was not published');
    }
    case 'child_page': {
      const local = lessonLink(block.id, context);
      return local
        ? `<p><a href="${escapeHtml(local)}">${escapeHtml(data?.title ?? 'Linked lesson')}</a></p>`
        : placeholder(`Child page not published: ${data?.title ?? 'untitled'}`);
    }
    default:
      return `${unsupported(block, context)}${renderBlocks(block.children, context)}`;
  }
}

export function renderBlocks(blocks = [], context) {
  let html = '';
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block.type === 'bulleted_list_item' || block.type === 'numbered_list_item') {
      const type = block.type;
      const tag = type === 'bulleted_list_item' ? 'ul' : 'ol';
      const items = [];
      while (index < blocks.length && blocks[index].type === type) {
        items.push(renderBlock(blocks[index], context));
        index += 1;
      }
      index -= 1;
      html += `<${tag}>${items.join('')}</${tag}>`;
    } else {
      html += renderBlock(block, context);
    }
  }
  return html;
}

function layout(title, content) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/style.css"></head><body><a class="skip" href="#content">Skip to content</a><main id="content">${content}</main></body></html>`;
}

export function renderIndex(config) {
  const items = config.lessons.map((lesson) => `<li><a href="/lessons/${encodeURIComponent(lesson.slug)}">${escapeHtml(lesson.title)}</a></li>`).join('');
  return layout('Lessons', `<h1>Lessons</h1><ul class="lesson-list">${items}</ul>`);
}

export function renderUnavailable() {
  return layout('Lesson unavailable', '<h1>Lesson unavailable</h1><p>This lesson has not been published yet. Please check back later.</p>');
}

export function renderLesson({ lesson, blocks, assets, publishedAt, config, onUnsupported }) {
  const context = {
    config,
    assets,
    onUnsupported,
    imageAlt(caption = []) {
      const text = caption.map((item) => item.plain_text ?? '').join('').trim();
      return text || 'Lesson image';
    },
  };
  const time = escapeHtml(publishedAt);
  return layout(lesson.title, `<h1>${escapeHtml(lesson.title)}</h1><p class="meta">Last successfully published: <time datetime="${time}">${time}</time></p>${renderBlocks(blocks, context)}`);
}
