// audio.js - webaudio, every sound is optional. missing file = silence.
import { fetchBytes, track } from './loader.js';

const AC = window.AudioContext || window.webkitAudioContext;
let ctx = null, master = null, ambient = null;
const bufs = new Map();
const listener = { x: 0, y: 0, z: 0 };

try { if (AC) { ctx = new AC(); master = ctx.createGain(); master.connect(ctx.destination); } } catch (e) { ctx = null; }

export function unlock() { if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {}); }
export function setVolume(v) { if (master) master.gain.value = v; }
export function setListener(p) { listener.x = p.x; listener.y = p.y; listener.z = p.z; }

// tries name.mp3 then name.ogg. a 404 on both = silent (not a failure), a stall = reported as timed out.
export function load(name) {
  return track('sound', name, async fresh => {
    if (!ctx) { bufs.set(name, null); return { status: 'missing', detail: 'no audio support' }; }
    let worst = 'missing', detail = '';
    for (const ext of ['mp3', 'ogg']) {
      const r = await fetchBytes(`assets/sounds/${name}.${ext}`, null, fresh);
      if (r.status === 'ok') {
        try { bufs.set(name, await ctx.decodeAudioData(r.data)); return { status: 'ok' }; }
        catch (e) { worst = 'broken'; detail = 'could not decode the audio file'; continue; }
      }
      if (r.status !== 'missing') { worst = r.status; detail = r.detail || ''; }
    }
    if (!bufs.has(name)) bufs.set(name, null);
    return { status: worst, detail };
  });
}

// at = optional {x,y,z} for distance attenuation
export function play(name, { volume = 1, rate = 1, at = null } = {}) {
  const buf = bufs.get(name);
  if (!ctx || !buf) return;
  let v = volume;
  if (at) {
    const d = Math.hypot(at.x - listener.x, at.y - listener.y, at.z - listener.z);
    v *= Math.pow(Math.max(0, 1 - d / 70), 2);
    if (v < 0.01) return;
  }
  const src = ctx.createBufferSource(), g = ctx.createGain();
  src.buffer = buf; src.playbackRate.value = rate; g.gain.value = v;
  src.connect(g); g.connect(master);
  src.start();
}

export function startAmbient() {
  stopAmbient();
  const buf = bufs.get('wind');
  if (!ctx || !buf) return;
  const src = ctx.createBufferSource(), g = ctx.createGain();
  src.buffer = buf; src.loop = true; g.gain.value = 0.3;
  src.connect(g); g.connect(master); src.start();
  ambient = src;
}
export function stopAmbient() { try { ambient?.stop(); } catch (e) {} ambient = null; }
