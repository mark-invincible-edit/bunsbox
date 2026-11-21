// mapfile.js - the .bm (bunsbox map) format: validation, building the world from it, and previews.
// a .bm file is plain json. everything is clamped/whitelisted because multiplayer clients load the host's map.
import * as THREE from 'three';
import { boxMaterials } from './assets.js';
import { TEXTURE_FILES } from './config.js';
import { getSpawnable } from './spawnables.js';

export const MAPLIM = { PARTS: 500, PROPS: 250, SPAWNS: 16 };
export const ENV_LABELS = { day: 'sunny day', overcast: 'overcast', sunset: 'sunset', night: 'night' };
export const ENVS = {
  day: { sky: '#8ecbff', fog: ['#a9d4f5', 80, 280], hemi: ['#cfe8ff', '#4d6b3a', 1.1], sun: '#fff1d0', sunI: 2.4 },
  overcast: { sky: '#9aa4ad', fog: ['#9aa4ad', 50, 200], hemi: ['#dfe6ee', '#55575a', 1.0], sun: '#ffffff', sunI: 2.0 },
  sunset: { sky: '#e8b98a', fog: ['#e3b890', 60, 240], hemi: ['#ffe2c0', '#6b4a33', 1.0], sun: '#ffd9a8', sunI: 2.6 },
  night: { sky: '#0b1022', fog: ['#0b1022', 30, 140], hemi: ['#3a4a7a', '#14161a', 0.7], sun: '#8fa4ff', sunI: 0.8 },
};
const SURFACE = { 'grassground.png': 'grass', 'woodplanks.png': 'wood', 'rockyground.png': 'rock', 'metalplates.png': 'metal', 'rustymetal.png': 'metal' };
const TEXCOL = { 'grassground.png': '#4f8f3b', 'woodplanks.png': '#8b5a2b', 'rockyground.png': '#8b7762', 'metalplates.png': '#666666', 'rustymetal.png': '#9a5a3c', 'concreteground.png': '#8a8a8a', 'concretewall.png': '#777777' };

export const propAllowed = s => !!s && !s.npc && !s.dialog && !s.nextbot;

// ---------------------------------------------------------------- validation
const num = (v, d, lo, hi) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
const vec = (a, d, lo = -5000, hi = 5000) => (Array.isArray(a) && a.length === 3) ? a.map((v, i) => num(v, d[i], lo, hi)) : d.slice();
const hex = (v, d) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)) ? v.toLowerCase() : d;
const str = (v, max, d = '') => typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').slice(0, max) : d;

export function normalizePart(p) {
  if (!p || typeof p !== 'object') return null;
  const sphere = p.shape === 'sphere';
  const size = vec(p.size, [4, 1, 4], 0.1, 1000);
  if (sphere) size.fill(size[0]);
  return {
    shape: sphere ? 'sphere' : 'box', pos: vec(p.pos, [0, 0, 0]), rot: vec(p.rot, [0, 0, 0], -3600, 3600), size,
    tex: TEXTURE_FILES.includes(p.tex) ? p.tex : null, color: hex(p.color, '#ffffff'), tile: num(p.tile, 4, 0.25, 100),
    anchored: p.anchored !== false, collide: p.collide !== false, mass: num(p.mass, 10, 0.1, 100000), damage: num(p.damage, 0, 0, 1000), bouncy: !!p.bouncy,
  };
}
function normalizeProp(p) {
  const s = getSpawnable(p?.key);
  if (!propAllowed(s)) return null;
  return { key: s.id, pos: vec(p.pos, [0, 0, 0]), rot: vec(p.rot, [0, 0, 0], -3600, 3600), anchored: p.anchored === true,
    mass: num(p.mass, s.mass, 0.1, 100000), damage: num(p.damage, 0, 0, 1000), bouncy: p.bouncy === undefined ? !!s.bouncy : !!p.bouncy };
}
export function normalizeMap(o) {
  if (!o || o.format !== 'bunsbox-map') throw new Error('not a bunsbox map (.bm) file');
  if (!(o.version <= 1)) throw new Error('this map was made with a newer version of the game');
  const e = o.env || {}, b = ENVS.day;
  const env = {
    sky: hex(e.sky, b.sky),
    fog: [hex(e.fog?.[0], b.fog[0]), num(e.fog?.[1], b.fog[1], 1, 2000), num(e.fog?.[2], b.fog[2], 10, 5000)],
    hemi: [hex(e.hemi?.[0], b.hemi[0]), hex(e.hemi?.[1], b.hemi[1]), num(e.hemi?.[2], b.hemi[2], 0, 5)],
    sun: hex(e.sun, b.sun), sunI: num(e.sunI, b.sunI, 0, 6),
  };
  const m = o.meta || {};
  return {
    format: 'bunsbox-map', version: 1,
    meta: { name: str(m.name, 60, 'untitled map') || 'untitled map', description: str(m.description, 400), author: str(m.author, 40, 'unknown') || 'unknown' },
    env,
    parts: (Array.isArray(o.parts) ? o.parts : []).slice(0, MAPLIM.PARTS).map(normalizePart).filter(Boolean),
    props: (Array.isArray(o.props) ? o.props : []).slice(0, MAPLIM.PROPS).map(normalizeProp).filter(Boolean),
    spawns: (Array.isArray(o.spawns) ? o.spawns : []).slice(0, MAPLIM.SPAWNS).map(s => vec(s, [0, 2, 0])),
  };
}
export function parseMap(text) {
  let o;
  try { o = JSON.parse(text); } catch (e) { throw new Error('that file is not valid json'); }
  return normalizeMap(o);
}

// ---------------------------------------------------------------- visuals
let unitBox = null, unitSphere = null;
export function partMaterial(p) {
  const m = boxMaterials(p.size, { tex: p.tex, tile: p.tile, color: 0x888888, tint: new THREE.Color(p.color).getHex() });
  return p.shape === 'sphere' ? m[4] : m;
}
// unit geometry scaled to the part size
export function partMesh(p) {
  unitBox ||= new THREE.BoxGeometry(1, 1, 1);
  unitSphere ||= new THREE.SphereGeometry(0.5, 24, 16);
  unitBox.userData.keep = unitSphere.userData.keep = true;      // shared by every part, never disposed when a session ends
  const m = new THREE.Mesh(p.shape === 'sphere' ? unitSphere : unitBox, partMaterial(p));
  m.scale.set(p.size[0], p.size[1], p.size[2]);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}
// a spawnable-like spec so unanchored parts can live in the physics world as props
export function specFromPart(p) {
  return { id: '__part', name: 'Part', category: '_', shape: p.shape, size: p.shape === 'sphere' ? [p.size[0] / 2] : p.size.map(v => v / 2),
    mass: p.mass, color: parseInt(p.color.slice(1), 16), bouncy: p.bouncy, part: p };
}

// ---------------------------------------------------------------- building the world
const D2R = Math.PI / 180;
// static (anchored) parts: meshes + colliders. returns the damaging ones as hazards.
export function buildCustom(bm, { group, physics }) {
  const hazards = [];
  for (const p of bm.parts) {
    if (!p.anchored) continue;                         // dynamic parts are spawned as props by the host (see entitiesOf)
    const m = partMesh(p);
    m.position.set(...p.pos);
    m.rotation.set(p.rot[0] * D2R, p.rot[1] * D2R, p.rot[2] * D2R);
    group.add(m);
    const surface = SURFACE[p.tex] || 'concrete';
    if (p.collide) {
      if (p.shape === 'sphere') physics.addStaticSphere(p.size[0] / 2, p.pos, surface);
      else physics.addStaticBox(p.size, p.pos, m.quaternion, surface);
    }
    if (p.damage > 0) hazards.push({ pos: m.position.clone(), quat: m.quaternion.clone(), half: p.shape === 'sphere' ? [p.size[0] / 2] : p.size.map(v => v / 2), sphere: p.shape === 'sphere', damage: p.damage });
  }
  return hazards;
}

// things the host spawns as physics props: unanchored parts + all props (anchored props become static bodies)
export function entitiesOf(bm) {
  const toQ = r => { const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(r[0] * D2R, r[1] * D2R, r[2] * D2R)); return [q.x, q.y, q.z, q.w]; };
  const out = [];
  for (const p of bm.parts) if (!p.anchored) out.push({ key: '__part', pos: p.pos, quat: toQ(p.rot), data: { part: p, damage: p.damage }, mass: p.mass, anchored: false, bouncy: p.bouncy });
  for (const p of bm.props) out.push({ key: p.key, pos: p.pos, quat: toQ(p.rot), data: { damage: p.damage }, mass: p.mass, anchored: p.anchored, bouncy: p.bouncy });
  return out;
}

// same shape the built-in maps use, so startSession treats both the same
export function customMapToDef(bm) {
  const e = bm.env, c = s => parseInt(s.slice(1), 16);
  return { id: 'custom', name: bm.meta.name, custom: bm, sky: c(e.sky), fog: { color: c(e.fog[0]), near: e.fog[1], far: e.fog[2] },
    hemi: [c(e.hemi[0]), c(e.hemi[1]), e.hemi[2]], sun: c(e.sun), sunI: e.sunI, spawns: bm.spawns.length ? bm.spawns : [[0, 3, 0]] };
}

// top-down preview for the map select screen
export function drawCustomPreview(cv, bm) {
  const ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
  ctx.fillStyle = bm.env.sky; ctx.fillRect(0, 0, W, H);
  const pts = [...bm.parts.map(p => [p.pos[0], p.pos[2], Math.max(p.size[0], p.size[2]) / 2]), ...bm.props.map(p => [p.pos[0], p.pos[2], 0.5]), ...bm.spawns.map(s => [s[0], s[2], 0.5])];
  let x0 = -10, x1 = 10, z0 = -10, z1 = 10;
  for (const [x, z, r] of pts) { x0 = Math.min(x0, x - r); x1 = Math.max(x1, x + r); z0 = Math.min(z0, z - r); z1 = Math.max(z1, z + r); }
  const k = Math.min((W - 16) / (x1 - x0), (H - 16) / (z1 - z0)), ox = W / 2 - (x0 + x1) / 2 * k, oz = H / 2 - (z0 + z1) / 2 * k;
  for (const p of [...bm.parts].sort((a, b) => a.pos[1] - b.pos[1])) {
    ctx.save();
    ctx.translate(ox + p.pos[0] * k, oz + p.pos[2] * k);
    ctx.rotate(-p.rot[1] * D2R);
    ctx.fillStyle = TEXCOL[p.tex] || p.color; ctx.strokeStyle = 'rgba(0,0,0,.4)'; ctx.lineWidth = 1;
    if (p.shape === 'sphere') { ctx.beginPath(); ctx.arc(0, 0, p.size[0] / 2 * k, 0, 7); ctx.fill(); ctx.stroke(); }
    else { ctx.fillRect(-p.size[0] / 2 * k, -p.size[2] / 2 * k, p.size[0] * k, p.size[2] * k); ctx.strokeRect(-p.size[0] / 2 * k, -p.size[2] / 2 * k, p.size[0] * k, p.size[2] * k); }
    ctx.restore();
  }
  ctx.fillStyle = '#f2b01e';
  for (const p of bm.props) { ctx.beginPath(); ctx.arc(ox + p.pos[0] * k, oz + p.pos[2] * k, 3, 0, 7); ctx.fill(); }
  ctx.fillStyle = '#4cc26a';
  for (const s of bm.spawns) { ctx.beginPath(); ctx.arc(ox + s[0] * k, oz + s[2] * k, 5, 0, 7); ctx.fill(); }
}
