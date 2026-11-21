// maps.js - the 3 maps. generation is deterministic (seeded rng) because every client
// builds the map itself instead of downloading it.
import * as THREE from 'three';
import { boxMaterials, getTexture } from './assets.js';

function mulberry32(a) {
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

class MapBuilder {
  constructor(group, physics) { this.group = group; this.physics = physics; }

  // o: size[w,h,d], pos[x,y,z], rot[x,y,z] euler, tex, tile (meters per texture repeat), color, tint, surface, shadow
  box(o) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...o.size), boxMaterials(o.size, o));
    mesh.position.set(...o.pos);
    mesh.rotation.set(...(o.rot || [0, 0, 0]));
    mesh.castShadow = o.shadow !== false;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.physics.addStaticBox(o.size, o.pos, mesh.quaternion, o.surface || 'concrete');
    return mesh;
  }

  // straight ramp. start = point where the top surface touches the ground/base,
  // it climbs `rise` over `len` heading along +x rotated by yaw (yaw 0 = +x, pi = -x, -pi/2 = +z)
  ramp(o) {
    const a = Math.atan2(o.rise, o.len), hyp = Math.hypot(o.len, o.rise), t = o.thick || 0.5;
    const cx = o.len / 2 + Math.sin(a) * t / 2, cy = o.rise / 2 - Math.cos(a) * t / 2;
    const yaw = o.yaw || 0;
    return this.box({
      ...o, size: [hyp, t, o.width],
      pos: [o.start[0] + cx * Math.cos(yaw), o.start[1] + cy, o.start[2] - cx * Math.sin(yaw)],
      rot: [0, yaw, a],
    });
  }
}

// small wooden/metal building with a 2m doorway in the +z wall
function cabin(b, x, z, { w = 8, d = 8, h = 3, roofTex = 'woodplanks.png', roofColor = 0x6b4423 } = {}) {
  const t = 0.3, W = 'woodplanks.png';
  const wall = (sx, sy, sz, px, py, pz) => b.box({ size: [sx, sy, sz], pos: [px, py, pz], tex: W, tile: 2, color: 0x7a4e24, surface: 'wood' });
  b.box({ size: [w, 0.2, d], pos: [x, 0.1, z], tex: W, tile: 2, color: 0x8b5a2b, surface: 'wood' });
  wall(w, h, t, x, 0.2 + h / 2, z - d / 2 + t / 2);
  wall(t, h, d, x - w / 2 + t / 2, 0.2 + h / 2, z);
  wall(t, h, d, x + w / 2 - t / 2, 0.2 + h / 2, z);
  const seg = (w - 2) / 2;
  wall(seg, h, t, x - 1 - seg / 2, 0.2 + h / 2, z + d / 2 - t / 2);
  wall(seg, h, t, x + 1 + seg / 2, 0.2 + h / 2, z + d / 2 - t / 2);
  wall(2, h - 2.2, t, x, 0.2 + 2.2 + (h - 2.2) / 2, z + d / 2 - t / 2);   // lintel above a 2.2m door
  b.box({ size: [w + 1, 0.3, d + 1], pos: [x, 0.2 + h + 0.15, z], tex: roofTex, tile: 2, color: roofColor, surface: roofTex === 'rustymetal.png' ? 'metal' : 'wood' });
}

export const MAPS = [
  {
    id: 'grasslands', name: 'Grasslands', seed: 11,
    desc: 'big open grass field with rocky patches, a cabin and a wooden watchtower.',
    sky: 0x8ecbff, fog: { color: 0xa9d4f5, near: 80, far: 280 }, hemi: [0xcfe8ff, 0x4d6b3a, 1.1], sun: 0xfff1d0, sunI: 2.4,
    spawns: [[0, 0.5, 0], [5, 0.5, 3], [-5, 0.5, 3], [0, 0.5, 7]],
    preview: { sky: ['#6fb4f0', '#cfe8ff'], ground: { tex: 'grassground.png', color: '#4f8f3b' },
      shapes: [[0.55, 0.2, 0.22, 'woodplanks.png', '#8b5a2b'], [0.15, 0.07, 0.5, 'woodplanks.png', '#7a4e24'], [0.04, 0.22, 0.04, 'rockyground.png', '#808080']] },
    build(b, rng) {
      b.box({ size: [500, 2, 500], pos: [0, -1, 0], tex: 'grassground.png', tile: 5, color: 0x4f8f3b, surface: 'grass', shadow: false });
      for (let i = 0; i < 14; i++) {                       // rocky patches (thin so you walk over them)
        const x = (rng() - 0.5) * 220, z = (rng() - 0.5) * 220, w = 8 + rng() * 14, d = 8 + rng() * 14, r = rng() * 3;
        if (Math.hypot(x, z) < 12) continue;
        b.box({ size: [w, 0.1, d], pos: [x, 0.05, z], rot: [0, r, 0], tex: 'rockyground.png', tile: 3, color: 0x808080, surface: 'rock', shadow: false });
      }
      cabin(b, 16, -22);
      cabin(b, -30, 25, { w: 6, d: 6, h: 2.8 });
      // watchtower: 4 posts, deck at y=6, long ramp up
      for (const [px, pz] of [[-35, -33], [-29, -33], [-35, -27], [-29, -27]]) b.box({ size: [0.5, 6, 0.5], pos: [px, 3, pz], tex: 'woodplanks.png', tile: 2, color: 0x7a4e24, surface: 'wood' });
      b.box({ size: [8, 0.3, 8], pos: [-32, 5.85, -30], tex: 'woodplanks.png', tile: 2, color: 0x8b5a2b, surface: 'wood' });
      b.ramp({ start: [-52, 0, -30], len: 14, rise: 6, width: 3, yaw: 0, tex: 'woodplanks.png', tile: 2, color: 0x8b5a2b, surface: 'wood' });
      // a kicker ramp to play with
      b.ramp({ start: [-12, 0, 14], len: 8, rise: 2, width: 5, yaw: 0, tex: 'woodplanks.png', tile: 2, color: 0x8b5a2b, surface: 'wood' });
    },
  },
  {
    id: 'industrial', name: 'Industrial Yard', seed: 22,
    desc: 'walled concrete arena with metal platforms, ramps and stacked rusty containers.',
    sky: 0x9aa4ad, fog: { color: 0x9aa4ad, near: 50, far: 200 }, hemi: [0xdfe6ee, 0x55575a, 1.0], sun: 0xffffff, sunI: 2.0,
    spawns: [[0, 0.5, 0], [4, 0.5, 4], [-4, 0.5, 4], [0, 0.5, -6]],
    preview: { sky: ['#8892a0', '#b8c0c8'], ground: { tex: 'concreteground.png', color: '#8a8a8a' },
      shapes: [[0.1, 0.35, 0.18, 'rustymetal.png', '#b5533c'], [0.5, 0.3, 0.18, 'rustymetal.png', '#3c6fb5'], [0.65, 0.3, 0.1, 'metalplates.png', '#666'], [0, 1, 0.3, 'concretewall.png', '#777']] },
    build(b) {
      const T = 'concreteground.png', W = 'concretewall.png', M = 'metalplates.png', R = 'rustymetal.png';
      b.box({ size: [160, 2, 160], pos: [0, -1, 0], tex: T, tile: 4, color: 0x8a8a8a, surface: 'concrete', shadow: false });
      for (const [sx, sz, px, pz] of [[160, 2, 0, -80], [160, 2, 0, 80], [2, 160, -80, 0], [2, 160, 80, 0]]) b.box({ size: [sx, 12, sz], pos: [px, 6, pz], tex: W, tile: 5, color: 0x777777 });
      b.box({ size: [40, 6, 1.5], pos: [-30, 3, -25], tex: W, tile: 4, color: 0x777777 });
      b.box({ size: [1.5, 6, 36], pos: [25, 3, -45], tex: W, tile: 4, color: 0x777777 });
      b.box({ size: [30, 6, 1.5], pos: [-45, 3, 30], tex: W, tile: 4, color: 0x777777 });
      // metal platform (top at y=4) + ramp
      for (const [lx, lz] of [[23, 5], [37, 5], [23, 15], [37, 15]]) b.box({ size: [1, 4, 1], pos: [lx, 2, lz], tex: M, tile: 2, color: 0x666666, surface: 'metal' });
      b.box({ size: [16, 0.5, 12], pos: [30, 3.75, 10], tex: M, tile: 2, color: 0x666666, surface: 'metal' });
      b.ramp({ start: [10, 0, 10], len: 12, rise: 4, width: 4, yaw: 0, tex: M, tile: 2, color: 0x666666, surface: 'metal' });
      // containers (tint multiplies the rusty texture)
      const cont = (x, z, yaw, tint, lvl = 0) => b.box({ size: [12, 2.8, 2.6], pos: [x, 1.4 + lvl * 2.8, z], rot: [0, yaw, 0], tex: R, tile: 3, color: tint, tint, surface: 'metal' });
      cont(-45, -50, 0, 0xb5533c); cont(-45, -50, 0, 0xc9a13c, 1); cont(-45, -46.5, 0, 0x3c6fb5);
      cont(-20, -60, 0, 0x4f8f4f); cont(-20, -56.5, 0, 0xc9a13c);
      cont(50, 40, Math.PI / 2, 0xb5533c); cont(50, 28, Math.PI / 2, 0x3c6fb5); cont(-10, 55, 0, 0x4f8f4f);
      b.ramp({ start: [-64, 0, -50], len: 13, rise: 5.6, width: 3, yaw: 0, tex: M, tile: 2, color: 0x666666, surface: 'metal' });   // up onto the stack
      b.ramp({ start: [-10, 0, 38], len: 8, rise: 2, width: 6, yaw: -Math.PI / 2, tex: M, tile: 2, color: 0x666666, surface: 'metal' });
    },
  },
  {
    id: 'canyon', name: 'Rocky Canyon', seed: 33,
    desc: 'narrow canyon with high rock ledges, boulders and a small wooden outpost.',
    sky: 0xe8b98a, fog: { color: 0xe3b890, near: 60, far: 240 }, hemi: [0xffe2c0, 0x6b4a33, 1.0], sun: 0xffd9a8, sunI: 2.6,
    spawns: [[30, 0.5, 0], [34, 0.5, 4], [26, 0.5, -4], [38, 0.5, 0]],
    preview: { sky: ['#e8a870', '#f3d2ae'], ground: { tex: 'rockyground.png', color: '#8b7762' },
      shapes: [[0, 0.3, 0.6, 'rockyground.png', '#9a6f4e'], [0.7, 0.3, 0.7, 'rockyground.png', '#9a6f4e'], [0.38, 0.2, 0.15, 'woodplanks.png', '#7a4e24']] },
    build(b, rng) {
      const R = 'rockyground.png';
      b.box({ size: [300, 2, 56], pos: [0, -1, 0], tex: R, tile: 5, color: 0x8b7762, surface: 'rock', shadow: false });
      for (const s of [-1, 1]) b.box({ size: [300, 44, 30], pos: [0, 21, s * 43], tex: R, tile: 9, color: 0x9a6f4e, surface: 'rock' });
      for (const s of [-1, 1]) b.box({ size: [10, 44, 70], pos: [s * 155, 21, 0], tex: R, tile: 9, color: 0x9a6f4e, surface: 'rock' });
      // ledge A (top y=5) + ramp up from the east
      b.box({ size: [26, 5, 10], pos: [-40, 2.5, -23], tex: R, tile: 5, color: 0x9a6f4e, surface: 'rock' });
      b.ramp({ start: [-15, 0, -23], len: 12, rise: 5, width: 5, yaw: Math.PI, tex: R, tile: 5, color: 0x9a6f4e, surface: 'rock', thick: 1 });
      // ledge B (top y=10) + long ramp
      b.box({ size: [18, 10, 9], pos: [35, 5, 23.5], tex: R, tile: 5, color: 0x9a6f4e, surface: 'rock' });
      b.ramp({ start: [4, 0, 23.5], len: 22, rise: 10, width: 5, yaw: 0, tex: R, tile: 5, color: 0x9a6f4e, surface: 'rock', thick: 1 });
      for (let i = 0; i < 10; i++) {                       // boulders
        const x = (rng() - 0.5) * 200, z = (rng() - 0.5) * 36, s = 2 + rng() * 3, r = rng() * 3;
        if (Math.abs(x - 30) < 12 && Math.abs(z) < 10) continue;   // keep the spawn clear
        b.box({ size: [s * 1.3, s, s], pos: [x, s / 2 - 0.1, z], rot: [0, r, 0], tex: R, tile: 3, color: 0xa07a58, surface: 'rock' });
      }
      cabin(b, -85, 0, { w: 10, d: 8, h: 3.2, roofTex: 'rustymetal.png', roofColor: 0x8a5a44 });
      b.box({ size: [6, 0.3, 4], pos: [-85, 0.15, 7], tex: 'woodplanks.png', tile: 2, color: 0x8b5a2b, surface: 'wood' });
    },
  },
];

export function buildMap(map, { group, physics }) {
  map.build(new MapBuilder(group, physics), mulberry32(map.seed));
}

// side-view preview drawn on a canvas, using the real textures when they loaded
export function drawPreview(canvas, map) {
  const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height, hor = H * 0.62, p = map.preview;
  const fillFor = (tex, color) => {
    const img = tex ? getTexture(tex)?.image : null;
    if (img) {
      try { const pat = ctx.createPattern(img, 'repeat'); pat.setTransform(new DOMMatrix().scale(0.22)); return pat; } catch (e) { /* fall through */ }
    }
    return color;
  };
  const g = ctx.createLinearGradient(0, 0, 0, hor);
  g.addColorStop(0, p.sky[0]); g.addColorStop(1, p.sky[1]);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, hor);
  ctx.fillStyle = fillFor(p.ground.tex, p.ground.color); ctx.fillRect(0, hor, W, H - hor);
  for (const [x, w, h, tex, color] of p.shapes) {
    ctx.fillStyle = fillFor(tex, color);
    ctx.fillRect(x * W, hor - h * H, w * W, h * H + 4);
    ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.lineWidth = 2; ctx.strokeRect(x * W, hor - h * H, w * W, h * H + 4);
  }
  const v = ctx.createLinearGradient(0, H * 0.7, 0, H);
  v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,.35)');
  ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
}
