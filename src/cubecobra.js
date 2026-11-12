'use strict';

/**
 * Cube Cobra lookup. Pulls Name, Author, Card Count and Tags for a cube.
 *
 * Cube Cobra has no officially versioned API for this, so two sources are
 * tried and merged: the public cube JSON endpoint, then the overview page
 * (which embeds its data as `window.reactProps`). Field names are matched
 * loosely so small upstream changes don't break it. Only the cube ID from
 * the admin's URL is ever used, so requests always go to cubecobra.com.
 */

const DEFAULT_BASE = 'https://cubecobra.com';
const TIMEOUT_MS = 10000;
const MAX_BYTES = 20 * 1024 * 1024;
const USER_AGENT = 'cube-draft-voting/1.0';

class CubeCobraError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.name = 'CubeCobraError';
    this.status = status;
  }
}

/** Accepts a Cube Cobra URL (overview, list, /c/ short link...) or a bare ID. */
function parseCubeUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new CubeCobraError('Cube URL is required', 400);

  if (/^[A-Za-z0-9_-]{1,64}$/.test(raw)) {
    return { id: raw, url: `${DEFAULT_BASE}/cube/overview/${raw}` };
  }

  let u;
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new CubeCobraError(`"${raw}" is not a valid URL`, 400);
  }
  if (!['cubecobra.com', 'www.cubecobra.com'].includes(u.hostname.toLowerCase())) {
    throw new CubeCobraError('Only cubecobra.com URLs are supported', 400);
  }
  const seg = u.pathname.split('/').filter(Boolean);
  let id;
  if (seg[0] === 'cube' && seg.length >= 3) id = seg[2];
  else if (seg[0] === 'c' && seg.length >= 2) id = seg[1];
  if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    throw new CubeCobraError('Could not find a cube ID in that URL. Use a link like https://cubecobra.com/cube/overview/your-cube', 400);
  }
  return { id, url: `${DEFAULT_BASE}/cube/overview/${id}` };
}

// ---------- extraction helpers (pure, unit tested) ----------

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

function pickAuthor(c) {
  const o = c.owner;
  return (
    (o && typeof o === 'object' && (str(o.username) || str(o.name))) ||
    str(o) ||
    str(c.ownerName) ||
    str(c.owner_name) ||
    str(c.username) ||
    str(c.author) ||
    null
  );
}

function pickCardCount(c) {
  for (const key of ['cardCount', 'card_count', 'numCards']) {
    const n = Number(c[key]);
    if (c[key] != null && Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  const cards = c.cards;
  if (Array.isArray(cards)) return cards.length;
  if (cards && Array.isArray(cards.mainboard)) return cards.mainboard.length;
  return null;
}

function pickTags(c) {
  let tags = c.tags;
  if (typeof tags === 'string') tags = tags.split(',');
  if (!Array.isArray(tags)) return [];
  const out = [];
  for (const t of tags) {
    const s = str(typeof t === 'object' && t ? t.name || t.tag : t);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

function looksLikeCube(o) {
  return (
    o && typeof o === 'object' && !Array.isArray(o) && typeof o.name === 'string' &&
    ['owner', 'cardCount', 'shortId', 'shortID', 'cards', 'tags'].some((k) => k in o)
  );
}

/** Finds the object that describes the cube inside a larger JSON document. */
function findCubeObject(root) {
  if (looksLikeCube(root)) return root;
  if (root && looksLikeCube(root.cube)) return root.cube;
  const queue = [root];
  for (let depth = 0; queue.length && depth < 5; depth++) {
    const next = [];
    for (const node of queue) {
      if (!node || typeof node !== 'object') continue;
      if (looksLikeCube(node)) return node;
      for (const v of Object.values(node)) if (v && typeof v === 'object') next.push(v);
    }
    queue.length = 0;
    queue.push(...next);
  }
  return null;
}

function extractFromJson(json) {
  const c = findCubeObject(json);
  if (!c) return null;
  return {
    name: str(c.name),
    author: pickAuthor(c),
    cardCount: pickCardCount(c),
    tags: pickTags(c)
  };
}

function decodeEntities(s) {
  return s
    .replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Pulls the JSON object assigned to `window.reactProps` out of page HTML. */
function extractReactProps(html) {
  const at = html.indexOf('window.reactProps');
  if (at < 0) return null;
  const start = html.indexOf('{', at);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function extractFromHtml(html) {
  const props = extractReactProps(html);
  const fromProps = props ? extractFromJson(props) : null;
  if (fromProps && fromProps.name) return fromProps;

  // Last resort: just the name from page metadata.
  const meta =
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (!meta) return fromProps;
  const name = decodeEntities(meta[1])
    .replace(/\s*[-|–]\s*Cube ?Cobra\s*$/i, '')
    .replace(/^(Cube\s+)?(Overview|List|Playtest|Analysis|Blog)\s*:\s*/i, '')
    .trim();
  if (!name) return fromProps;
  return { author: null, cardCount: null, tags: [], ...(fromProps || {}), name };
}

// ---------- network ----------

async function readLimited(res) {
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new CubeCobraError('Cube Cobra response was too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function get(fetchImpl, url, accept) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: accept }
    });
    if (res.status === 404) throw new CubeCobraError('Cube not found on Cube Cobra. Check the URL and that the cube is public', 404);
    if (!res.ok) throw new CubeCobraError(`Cube Cobra returned HTTP ${res.status}`, 502);
    return await readLimited(res);
  } catch (err) {
    if (err instanceof CubeCobraError) throw err;
    if (err.name === 'AbortError') throw new CubeCobraError('Cube Cobra took too long to respond', 504);
    throw new CubeCobraError(`Could not reach Cube Cobra (${err.cause?.code || err.message})`, 502);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @returns {Promise<{cubecobraId:string,url:string,name:string,author:string|null,cardCount:number|null,tags:string[]}>}
 */
async function fetchCubeInfo(input, { fetchImpl = fetch, baseUrl = process.env.CUBECOBRA_BASE_URL || DEFAULT_BASE } = {}) {
  const { id, url } = parseCubeUrl(input);
  const enc = encodeURIComponent(id);
  const sources = [
    async () => extractFromJson(JSON.parse(await get(fetchImpl, `${baseUrl}/cube/api/cubejson/${enc}`, 'application/json'))),
    async () => extractFromHtml(await get(fetchImpl, `${baseUrl}/cube/overview/${enc}`, 'text/html'))
  ];

  const info = { name: null, author: null, cardCount: null, tags: [] };
  let notFound = null;
  let lastError = null;
  for (const source of sources) {
    try {
      const got = await source();
      if (!got) continue;
      info.name = info.name || got.name;
      info.author = info.author || got.author;
      if (info.cardCount == null) info.cardCount = got.cardCount;
      if (!info.tags.length) info.tags = got.tags || [];
    } catch (err) {
      if (err instanceof CubeCobraError && err.status === 404) notFound = err;
      lastError = err;
    }
    if (info.name && info.author && info.cardCount != null) break;
  }

  if (!info.name) {
    if (notFound) throw notFound;
    throw new CubeCobraError(
      lastError instanceof CubeCobraError
        ? lastError.message
        : 'Could not read the cube details from Cube Cobra. You can enter them manually'
    );
  }
  return { cubecobraId: id, url, ...info };
}

module.exports = { fetchCubeInfo, parseCubeUrl, extractFromJson, extractFromHtml, extractReactProps, CubeCobraError };
