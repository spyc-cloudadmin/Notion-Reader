import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import { HttpError } from './errors.js';
import { safeExternalUrl } from './render.js';

const INLINE_IMAGE_TYPES = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
]);
const FILE_EXTENSIONS = new Map([
  ['application/pdf', '.pdf'],
  ['text/plain', '.txt'],
  ['application/zip', '.zip'],
  ['text/csv', '.csv'],
]);

function privateIpv4(address) {
  const parts = address.split('.').map(Number);
  const [a, b, c] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return !privateIpv4(address);
  if (family !== 6) return false;
  const normalized = address.toLowerCase().split('%')[0];
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice(7);
    if (net.isIP(mapped) === 4) return !privateIpv4(mapped);
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return false;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return false;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return false;
  const groups = [...left, ...Array(missing).fill('0'), ...right].map((part) => Number.parseInt(part, 16));
  if ((groups[0] & 0xe000) !== 0x2000) return false;
  return !(groups[0] === 0x2001 && groups[1] === 0x0db8);
}

function validateSource(value, allowedHosts) {
  const href = safeExternalUrl(value);
  if (!href) throw new HttpError(422, 'Invalid asset URL', 'invalid_asset_url');
  const url = new URL(href);
  if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname.toLowerCase()) || url.port) {
    throw new HttpError(422, 'Asset source is not allowlisted', 'asset_host_denied');
  }
  return url;
}

async function publicAddress(hostname) {
  let addresses;
  try {
    addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new HttpError(422, 'Asset DNS lookup failed', 'asset_dns_failed');
  }
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new HttpError(422, 'Asset resolves to a non-public address', 'asset_address_denied');
  }
  return addresses[0];
}

function requestBuffer(url, address, options) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: 'GET',
      servername: url.hostname,
      rejectUnauthorized: true,
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions.all) callback(null, [{ address: address.address, family: address.family }]);
        else callback(null, address.address, address.family);
      },
      headers: { Accept: '*/*', 'User-Agent': 'notion-lesson-reader/1.0' },
    }, (response) => {
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = response.headers.location;
        response.resume();
        resolve({ redirect: location ? new URL(location, url).href : null });
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new HttpError(422, `Asset download returned status ${status}`, 'asset_download_failed'));
        return;
      }
      const declaredLength = Number(response.headers['content-length']);
      if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) {
        response.resume();
        reject(new HttpError(422, 'Asset exceeds the size limit', 'asset_too_large'));
        return;
      }
      const chunks = [];
      let length = 0;
      response.on('data', (chunk) => {
        length += chunk.length;
        if (length > options.maxBytes) {
          request.destroy(new HttpError(422, 'Asset exceeds the size limit', 'asset_too_large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({
        data: Buffer.concat(chunks),
        contentType: String(response.headers['content-type'] ?? 'application/octet-stream').split(';')[0].trim().toLowerCase(),
      }));
      response.on('error', reject);
    });
    request.setTimeout(options.timeoutMs, () => {
      request.destroy(new HttpError(422, 'Asset download timed out', 'asset_timeout'));
    });
    request.on('error', reject);
    request.end();
  });
}

export async function downloadAsset(source, options) {
  let url = validateSource(source, options.allowedHosts);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const address = await publicAddress(url.hostname);
    const result = await requestBuffer(url, address, options);
    if (!('redirect' in result)) return result;
    if (!result.redirect || redirects === 3) {
      throw new HttpError(422, 'Asset redirect limit exceeded', 'asset_redirect_failed');
    }
    url = validateSource(result.redirect, options.allowedHosts);
  }
  throw new HttpError(422, 'Asset redirect limit exceeded', 'asset_redirect_failed');
}

function safeFilename(name, extension) {
  const base = String(name || 'download')
    .normalize('NFKD').replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^\.+/, '').slice(0, 80) || 'download';
  return base.toLowerCase().endsWith(extension) ? base : `${base}${extension}`;
}

export function assetLocation(source, block, downloaded, kind) {
  if (kind === 'image' && !INLINE_IMAGE_TYPES.has(downloaded.contentType)) {
    throw new HttpError(422, 'Image format is not safe for inline display', 'unsupported_image_type');
  }
  const extension = kind === 'image'
    ? INLINE_IMAGE_TYPES.get(downloaded.contentType)
    : FILE_EXTENSIONS.get(downloaded.contentType) ?? '.bin';
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 24);
  const originalName = block[kind === 'image' ? 'image' : block.type]?.name;
  const filename = `${hash}${extension}`;
  const dispositionName = safeFilename(originalName, extension);
  return {
    filename,
    contentType: downloaded.contentType,
    contentDisposition: `${kind === 'image' ? 'inline' : 'attachment'}; filename="${dispositionName}"`,
  };
}

export function assetSource(block) {
  if (!['image', 'file', 'pdf'].includes(block.type)) return null;
  const data = block[block.type];
  return data?.file?.url ?? data?.external?.url ?? null;
}
