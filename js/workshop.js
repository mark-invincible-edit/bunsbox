// workshop.js - community maps. lists the .bm files in the github repo and fetches them on demand.
// maps are plain json run through parseMap (validated + clamped), so a workshop file can never run code.
import { parseMap } from './mapfile.js';

export const REPO = { owner: 'mark-invincible-edit', repo: 'mapupload', branch: 'main' };
export const REPO_URL = `https://github.com/${REPO.owner}/${REPO.repo}`;
export const UPLOAD_URL = `https://github.com/${REPO.owner}/${REPO.repo}/fork`;      // fork it, add your .bm file, open a pull request
const MAX_BYTES = 2e6, MAX_MAPS = 60, TTL = 5 * 60 * 1000;
const NOT_MAPS = /(^|\/)(package(-lock)?|tsconfig|jsconfig|composer|manifest|renovate|\.eslintrc)\.json$/i;
const raw = path => `https://raw.githubusercontent.com/${REPO.owner}/${REPO.repo}/${REPO.branch}/${path.split('/').map(encodeURIComponent).join('/')}`;

async function getJSON(url, ms = 15000) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { Accept: 'application/vnd.github+json' } });
    if (r.status === 404 || r.status === 409) return { empty: true };     // 409 = brand new empty repo
    if (!r.ok) throw new Error(`http ${r.status}`);
    return await r.json();
  } catch (e) { throw new Error(e?.name === 'AbortError' ? 'timed out' : (e?.message || 'network error')); }
  finally { clearTimeout(t); }
}

const toEntry = (path, size) => ({ path, size: size || 0, name: path.replace(/^.*\//, '').replace(/\.(bm|json)$/i, ''), url: raw(path) });
const isMapFile = (path, size) => /\.(bm|json)$/i.test(path) && !NOT_MAPS.test(path) && (!size || size <= MAX_BYTES);

let listCache = null;
// -> [{ path, name, size, url }]. github's tree api first (one request), jsdelivr's file index if github is rate limiting us
export async function listMaps(force = false) {
  if (!force && listCache && Date.now() - listCache.t < TTL) return listCache.list;
  let files = null, firstErr;
  try {
    const j = await getJSON(`https://api.github.com/repos/${REPO.owner}/${REPO.repo}/git/trees/${REPO.branch}?recursive=1`);
    files = j.empty ? [] : (j.tree || []).filter(f => f.type === 'blob').map(f => ({ path: f.path, size: f.size }));
  } catch (e) { firstErr = e; }
  if (!files) {
    try {
      const j = await getJSON(`https://data.jsdelivr.com/v1/packages/gh/${REPO.owner}/${REPO.repo}@${REPO.branch}?structure=flat`);
      files = j.empty ? [] : (j.files || []).map(f => ({ path: String(f.name).replace(/^\//, ''), size: f.size }));
    } catch (e) { throw new Error(firstErr?.message || e.message); }
  }
  const list = files.filter(f => isMapFile(f.path, f.size)).map(f => toEntry(f.path, f.size)).sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_MAPS);
  listCache = { t: Date.now(), list };
  return list;
}

const mapCache = new Map();
// fetch + validate one map. throws if it is not a real bunsbox map
export async function loadMap(entry, force = false) {
  if (!force && mapCache.has(entry.url)) return mapCache.get(entry.url);
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), 20000);
  try {
    const r = await fetch(entry.url, { signal: ac.signal, cache: force ? 'reload' : 'default' });
    if (!r.ok) throw new Error(`http ${r.status}`);
    const text = await r.text();
    if (text.length > MAX_BYTES) throw new Error('file too big (2mb max)');
    const bm = parseMap(text);
    mapCache.set(entry.url, bm);
    return bm;
  } finally { clearTimeout(t); }
}

// run fn over items with a few at a time
export async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}
