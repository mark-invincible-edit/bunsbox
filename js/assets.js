// assets.js - every load resolves (null on failure), nothing here ever throws or hangs.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { PLAYER } from './config.js';

const TIMEOUT = 20000;
const texReady = new Map();    // file -> Texture
const gltfReady = new Map();   // path -> gltf
const texLoader = new THREE.TextureLoader();
const gltfLoader = new GLTFLoader();

export function loadTexture(file) {
  return new Promise(resolve => {
    const timer = setTimeout(() => { console.warn(`[assets] texture timeout: ${file}`); resolve(null); }, TIMEOUT);
    try {
      texLoader.load(`assets/${file}`, tex => {
        clearTimeout(timer);
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        texReady.set(file, tex);
        resolve(tex);
      }, undefined, () => { clearTimeout(timer); console.warn(`[assets] missing texture: ${file} (using solid color)`); resolve(null); });
    } catch (e) { clearTimeout(timer); resolve(null); }
  });
}
export const getTexture = file => texReady.get(file) || null;

export function loadModel(path) {
  return new Promise(resolve => {
    const timer = setTimeout(() => { console.warn(`[assets] model timeout: ${path}`); resolve(null); }, TIMEOUT);
    try {
      gltfLoader.load(`assets/${path}`, gltf => {
        clearTimeout(timer);
        if (PLAYER.STRIP_ROOT_MOTION) {
          for (const c of gltf.animations) c.tracks = c.tracks.filter(t => !/hips\.position$/i.test(t.name));
        }
        gltfReady.set(path, gltf);
        resolve(gltf);
      }, undefined, () => { clearTimeout(timer); console.warn(`[assets] missing model: ${path} (using placeholder)`); resolve(null); });
    } catch (e) { clearTimeout(timer); resolve(null); }
  });
}

// sync clone of a model that was preloaded; null if it failed to load
export function cloneModel(path) {
  const gltf = gltfReady.get(path);
  if (!gltf) return null;
  return { object: cloneSkinned(gltf.scene), clips: gltf.animations };
}

// ---- tiled materials ----
const matCache = new Map();
function material(file, rx, ry, color, tint) {
  const key = `${file}|${rx.toFixed(2)}|${ry.toFixed(2)}|${color}|${tint}`;
  if (matCache.has(key)) return matCache.get(key);
  const base = file ? texReady.get(file) : null;
  let m;
  if (base) {
    const t = base.clone();          // clone so each repeat value gets its own uv scale
    t.needsUpdate = true;            // clones start at version 0 and render blank without this
    t.repeat.set(rx, ry);
    m = new THREE.MeshStandardMaterial({ map: t, color: tint ?? 0xffffff, roughness: 0.92 });
  } else {
    m = new THREE.MeshStandardMaterial({ color: tint ?? color, roughness: 0.92 });
  }
  matCache.set(key, m);
  return m;
}

// six materials (one per box face) so the texture tiles at the same world size on every face.
// BoxGeometry face order: +x, -x, +y, -y, +z, -z
export function boxMaterials([w, h, d], { tex, tile = 4, color = 0x888888, tint }) {
  const f = (a, b) => material(tex, a / tile, b / tile, color, tint);
  const mx = f(d, h), my = f(w, d), mz = f(w, h);
  return [mx, mx, my, my, mz, mz];
}

// ---- labels + placeholders ----
export function makeLabel(text, { font = 48, color = '#fff', bg = 'rgba(0,0,0,.55)', scale = 0.0035 } = {}) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = `bold ${font}px sans-serif`;
  const w = Math.ceil(ctx.measureText(text).width) + 28, h = font + 22;
  c.width = w; c.height = h;
  ctx.font = `bold ${font}px sans-serif`;     // resizing a canvas resets its state
  ctx.fillStyle = bg;
  ctx.beginPath(); ctx.roundRect(0, 0, w, h, 14); ctx.fill();
  ctx.fillStyle = color; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  ctx.fillText(text, w / 2, h / 2 + 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  spr.scale.set(w * scale, h * scale, 1);
  return spr;
}

export function makePlaceholder({ shape = 'box', size = [0.5, 0.5, 0.5], color = 0xff00ff, label = null }) {
  const g = new THREE.Group();
  const geo = shape === 'sphere' ? new THREE.SphereGeometry(size[0], 16, 12)
    : new THREE.BoxGeometry(size[0] * 2, size[1] * 2, size[2] * 2);
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.7 }));
  m.castShadow = true; m.receiveShadow = true;
  g.add(m);
  if (label) {
    const s = makeLabel(label, { font: 36, scale: 0.0025 });
    s.position.y = (shape === 'sphere' ? size[0] : size[1]) + 0.35;
    g.add(s);
  }
  return g;
}
