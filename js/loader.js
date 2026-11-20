// loader.js - robust fetching: the timeout measures SILENCE (progress resets it), only a few downloads run at once,
// and everything is registered so the loading screen can say what timed out and offer a retry.
const IDLE_MS = 20000, HARD_MS = 240000, POOL = 5;
export const registry = new Map();   // "kind:path" -> {kind, path, status, detail, run}
let active = 0;
const waiting = [];
const acquire = () => new Promise(res => { const go = () => { active++; res(); }; active < POOL ? go() : waiting.push(go); });
const release = () => { active--; waiting.shift()?.(); };

// resolves { status, data?, detail? }  status: ok | missing (404) | timeout (stalled / network) | error (other http)
export async function fetchBytes(url, onProgress, fresh = false) {
  await acquire();
  const ac = new AbortController();
  let idle;
  const hard = setTimeout(() => ac.abort(), HARD_MS);
  const arm = () => { clearTimeout(idle); idle = setTimeout(() => ac.abort(), IDLE_MS); };
  try {
    arm();
    const res = await fetch(url, { signal: ac.signal, cache: fresh ? 'reload' : 'default' });
    if (res.status === 404 || res.status === 410) return { status: 'missing' };
    if (!res.ok) return { status: 'error', detail: `http ${res.status}` };
    if (!res.body) return { status: 'ok', data: await res.arrayBuffer() };
    const total = Number(res.headers.get('content-length')) || 0, rd = res.body.getReader(), parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      parts.push(value); got += value.length; arm(); onProgress?.(got, total);
    }
    const out = new Uint8Array(got);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return { status: 'ok', data: out.buffer };
  } catch (e) {
    return { status: 'timeout', detail: e?.name === 'AbortError' ? 'stalled, no data for 20s' : (e?.message || 'network error') };
  } finally { clearTimeout(idle); clearTimeout(hard); release(); }
}

// run(fresh) must do the whole load (fetch + decode + cache) and return { status, detail? }
export async function track(kind, path, run) {
  const entry = { kind, path, status: 'pending', detail: '', run };
  registry.set(`${kind}:${path}`, entry);
  let r;
  try { r = await run(false); } catch (e) { r = { status: 'error', detail: e?.message || 'failed' }; }
  entry.status = r.status; entry.detail = r.detail || '';
  if (r.status !== 'ok' && r.status !== 'missing') console.warn(`[assets] ${kind} ${path}: ${r.status} ${entry.detail}`);
  return r;
}

export const failed = () => [...registry.values()].filter(e => e.status === 'timeout' || e.status === 'error');
export const missing = () => [...registry.values()].filter(e => e.status === 'missing');

export async function retryFailed(onEach) {
  const list = failed();
  let done = 0;
  await Promise.all(list.map(async e => {
    let r;
    try { r = await e.run(true); } catch (err) { r = { status: 'error', detail: err?.message || 'failed' }; }
    e.status = r.status; e.detail = r.detail || '';
    onEach?.(++done, list.length);
  }));
  return failed();
}
