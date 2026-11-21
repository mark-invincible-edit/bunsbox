// effects.js - glowing sparks + explosion picture flash, muzzle flash, tracers, and the physgun beam.
import * as THREE from 'three';
import { EXPLOSION_IMAGES, BLOOD, GROUPS } from './config.js';

let glowTex = null, boomTex = null;
const UP = new THREE.Vector3(0, 1, 0);

export function getGlowTexture() {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(255,255,255,.85)');
  g.addColorStop(0.6, 'rgba(255,255,255,.2)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  return glowTex;
}

// tries explosion.png / .webp / .jpg / .gif in /assets. never throws.
export async function loadExplosionImage() {
  const loader = new THREE.TextureLoader();
  for (const f of EXPLOSION_IMAGES) {
    try {
      boomTex = await new Promise((res, rej) => loader.load(`assets/${f}`, res, undefined, rej));
      boomTex.colorSpace = THREE.SRGBColorSpace;
      return boomTex;
    } catch (e) { /* try next name */ }
  }
  console.warn('[effects] no explosion image in assets/ (using a soft glow flash instead)');
  return null;
}

// ---- blood: procedural textures, no files needed ----
let dropTex = null, splatTexs = null, planeGeo = null;
const _bd = new THREE.Vector3(), _bn = new THREE.Vector3(), _bz = new THREE.Vector3(0, 0, 1), _bs = new THREE.Vector3(), _bv = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);

function getDropTexture() {
  if (dropTex) return dropTex;
  const c = document.createElement('canvas'); c.width = c.height = 32;
  const x = c.getContext('2d'), g = x.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.65, 'rgba(255,255,255,1)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 32, 32);
  dropTex = new THREE.CanvasTexture(c); dropTex.colorSpace = THREE.SRGBColorSpace;
  return dropTex;
}
function getSplatTextures() {
  if (splatTexs) return splatTexs;
  splatTexs = [];
  for (let k = 0; k < 5; k++) {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const x = c.getContext('2d');
    const blob = (cx, cy, r) => {
      const g = x.createRadialGradient(cx, cy, r * 0.2, cx, cy, r);
      g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.7, 'rgba(255,255,255,.95)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = g; x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fill();
    };
    blob(64, 64, 16 + Math.random() * 10);
    const arms = 6 + Math.floor(Math.random() * 6);
    for (let i = 0; i < arms; i++) {                                  // streaks that thin out, each ending in a satellite drop
      const a = Math.random() * Math.PI * 2, len = 16 + Math.random() * 32;
      for (let s = 0; s < 6; s++) { const t = s / 5; blob(64 + Math.cos(a) * len * t, 64 + Math.sin(a) * len * t, (1 - t) * 7 + 2); }
      const sd = len + 6 + Math.random() * 12;
      blob(64 + Math.cos(a) * sd, 64 + Math.sin(a) * sd, 1.5 + Math.random() * 3);
    }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    splatTexs.push(t);
  }
  return splatTexs;
}

const additive = (map, color) => new THREE.SpriteMaterial({ map, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
const FLASH_TIME = 0.22;
const tracerGeo = new THREE.CylinderGeometry(0.012, 0.012, 1, 5, 1, true);

export class Effects {
  constructor(parent, physics = null) {
    this.parent = parent; this.physics = physics; this.items = []; this.shots = []; this.shake = 0;
    this.drops = []; this.decals = [];
    this.dropMats = [0x8a0505, 0xb30c0c].map(color => new THREE.SpriteMaterial({ map: getDropTexture(), color, transparent: true, depthWrite: false }));
    this.flash = new THREE.PointLight(0xffa040, 0, 80, 2);    // permanent so shaders never recompile mid-game
    parent.add(this.flash);
  }

  // gun muzzle flash: the explosion picture, tiny, for ~60ms. always drawn on top.
  muzzle(pos, size = 0.4) {
    const tex = boomTex || getGlowTexture();
    const mat = additive(tex, boomTex ? 0xffffff : 0xffc060);
    mat.depthTest = false; mat.rotation = Math.random() * Math.PI * 2;
    const s = new THREE.Sprite(mat);
    s.renderOrder = 20; s.position.copy(pos);
    const aspect = boomTex?.image ? boomTex.image.width / boomTex.image.height : 1;
    s.scale.set(size * aspect, size, 1);
    this.parent.add(s);
    this.shots.push({ obj: s, mat, t: 0, dur: 0.06 });
  }

  tracer(from, to) {
    const d = new THREE.Vector3().subVectors(to, from), len = d.length();
    if (len < 0.1) return;
    const mat = new THREE.MeshBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    const m = new THREE.Mesh(tracerGeo, mat);
    m.frustumCulled = false;
    m.position.copy(from).addScaledVector(d, 0.5);
    m.quaternion.setFromUnitVectors(UP, d.normalize());
    m.scale.set(1, len, 1);
    this.parent.add(m);
    this.shots.push({ obj: m, mat, t: 0, dur: 0.08 });
  }

  // blood burst at `pos`, spraying along `dir`. n ~ how hard the hit was (1 = pistol, 8+ = huge)
  blood(pos, dir, n = 1) {
    if (!BLOOD.ON) return;
    const d = _bd.copy(dir);
    if (d.lengthSq() < 1e-6) d.set(0, 0, -1);
    d.normalize();
    const count = Math.min(36, Math.round(8 + n * 5));
    for (let i = 0; i < count && this.drops.length < BLOOD.MAX_DROPS; i++) {
      const s = new THREE.Sprite(this.dropMats[i % 2]);
      const sz = 0.04 + Math.random() * 0.07;
      s.scale.set(sz, sz, 1); s.position.copy(pos);
      const back = Math.random() < 0.3 ? -0.5 : 1;                    // some of it sprays back at the shooter
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.2, Math.random() - 0.5).multiplyScalar(3.5)
        .addScaledVector(d, (1.5 + Math.random() * 5) * back);
      this.parent.add(s);
      this.drops.push({ s, v, life: 1.6 });
    }
    // instant splatter on whatever is behind the victim and on the floor under them
    this._splat(pos, d, 6, 0.55 + n * 0.08);
    this._splat(pos, _down, 4, 0.5 + n * 0.1);
    for (let i = 0; i < Math.min(3, Math.floor(n / 2)); i++) {
      _bv.set(d.x + (Math.random() - 0.5) * 1.2, d.y + (Math.random() - 0.6) * 1.2, d.z + (Math.random() - 0.5) * 1.2).normalize();
      this._splat(pos, _bv, 5, 0.4 + Math.random() * 0.4);
    }
  }
  _splat(from, dir, dist, size) {                                      // only static world geometry gets stained (moving props would leave floating stains)
    const h = this.physics?.raycastRay(from, dir, dist, GROUPS.WORLD);
    if (h) this.decal(h.point, h.normal, size * (0.6 + Math.random() * 0.8));
  }
  decal(point, normal, size) {
    planeGeo ||= new THREE.PlaneGeometry(1, 1);
    const tex = getSplatTextures();
    const mat = new THREE.MeshBasicMaterial({ map: tex[Math.floor(Math.random() * tex.length)], color: Math.random() < 0.5 ? 0x7d0b0b : 0x5e0707,
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    const m = new THREE.Mesh(planeGeo, mat);
    _bn.set(normal.x, normal.y, normal.z).normalize();
    m.quaternion.setFromUnitVectors(_bz, _bn);
    m.rotateZ(Math.random() * Math.PI * 2);
    m.position.set(point.x, point.y, point.z).addScaledVector(_bn, 0.012);
    m.scale.set(size, size, 1);
    this.parent.add(m);
    this.decals.push({ m, mat, t: 0 });
    if (this.decals.length > BLOOD.MAX_DECALS) this._killDecal(this.decals[0]);
  }
  _killDecal(d) { this.parent.remove(d.m); d.mat.dispose(); const i = this.decals.indexOf(d); if (i >= 0) this.decals.splice(i, 1); }
  dispose() {
    for (const d of [...this.decals]) this._killDecal(d);
    for (const d of this.drops) this.parent.remove(d.s);
    this.drops.length = 0;
  }

  explosion(pos, radius) {
    const p = new THREE.Vector3(pos.x, pos.y, pos.z);
    const tex = boomTex || getGlowTexture();
    const fm = additive(tex, boomTex ? 0xffffff : 0xffa040);
    const flash = new THREE.Sprite(fm);
    flash.position.copy(p);
    this.parent.add(flash);
    const aspect = boomTex?.image ? boomTex.image.width / boomTex.image.height : 1;

    const mats = [additive(getGlowTexture(), 0xffa733), additive(getGlowTexture(), 0xfff0b8)];
    const sparks = [], n = Math.min(120, 45 + Math.round(radius * 3));
    for (let i = 0; i < n; i++) {
      const s = new THREE.Sprite(mats[i % 3 === 0 ? 1 : 0]);
      s.position.copy(p);
      const d = new THREE.Vector3(Math.random() - 0.5, Math.random(), Math.random() - 0.5).normalize();
      d.y = d.y * 0.8 + 0.2;
      const v = d.normalize().multiplyScalar(radius * (0.7 + Math.random() * 1.9));
      const size0 = 0.18 + Math.random() * 0.3;
      s.scale.setScalar(size0);
      this.parent.add(s);
      sparks.push({ s, v, size0, life: 0.5 + Math.random() * 0.9 });
    }
    this.flash.position.copy(p);
    this.items.push({ t: 0, flash, fm, aspect, size: Math.max(3, radius * 1.5), sparks, mats, radius });
  }

  update(dt) {
    this.shake = Math.max(0, this.shake - dt * 1.5);
    for (const s of [...this.shots]) {
      s.t += dt;
      if (s.t >= s.dur) { this.parent.remove(s.obj); s.mat.dispose(); this.shots.splice(this.shots.indexOf(s), 1); continue; }
      s.mat.opacity = 1 - s.t / s.dur;
    }
    for (let i = this.drops.length - 1; i >= 0; i--) {                 // blood droplets: fall, and stain what they land on
      const d = this.drops[i];
      d.life -= dt; d.v.y -= 16 * dt;
      _bs.copy(d.v).multiplyScalar(dt);
      const len = _bs.length();
      const hit = (this.physics && len > 1e-4) ? this.physics.raycastRay(d.s.position, _bn.copy(d.v).normalize(), len + 0.03, GROUPS.WORLD) : null;
      if (hit) this.decal(hit.point, hit.normal, 0.1 + Math.random() * 0.2);
      else if (d.life > 0) { d.s.position.add(_bs); continue; }
      this.parent.remove(d.s);
      this.drops.splice(i, 1);
    }
    for (const d of [...this.decals]) {
      d.t += dt;
      const left = BLOOD.DECAL_LIFE - d.t;
      if (left <= 0) this._killDecal(d); else if (left < 4) d.mat.opacity = left / 4;
    }
    let light = 0;
    for (const it of [...this.items]) {
      it.t += dt;
      if (it.t < FLASH_TIME) {
        const k = it.t / FLASH_TIME, pop = 0.7 + 0.6 * (1 - Math.pow(1 - k, 3));
        it.flash.scale.set(it.size * it.aspect * pop, it.size * pop, 1);
        it.fm.opacity = 1 - k * k;
      } else it.flash.visible = false;

      let alive = false;
      for (const sp of it.sparks) {
        if (it.t >= sp.life) { sp.s.visible = false; continue; }
        alive = true;
        sp.v.multiplyScalar(Math.exp(-1.1 * dt));
        sp.v.y -= 14 * dt;
        sp.s.position.addScaledVector(sp.v, dt);
        sp.s.scale.setScalar(sp.size0 * (0.25 + (1 - it.t / sp.life)) * (0.8 + Math.random() * 0.4));
      }
      light = Math.max(light, it.radius * it.radius * 0.9 * Math.max(0, 1 - it.t * 4));

      if (it.t >= FLASH_TIME && !alive) {
        this.parent.remove(it.flash);
        for (const sp of it.sparks) this.parent.remove(sp.s);
        it.fm.dispose(); it.mats.forEach(m => m.dispose());
        this.items.splice(this.items.indexOf(it), 1);
      }
    }
    this.flash.intensity = light;
  }
}

// physgun laser: cylinder from `from` to `to` + glow at both ends
export class Beam {
  constructor(parent, color = 0x4db8ff) {
    this.mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 1, 6, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    const gm = additive(getGlowTexture(), color);
    this.a = new THREE.Sprite(gm); this.a.scale.setScalar(0.22);
    this.b = new THREE.Sprite(gm); this.b.scale.setScalar(0.45);
    this.parts = [this.mesh, this.a, this.b];
    this.parts.forEach(o => { o.visible = false; o.frustumCulled = false; parent.add(o); });
    this._d = new THREE.Vector3(); this._up = new THREE.Vector3(0, 1, 0);
  }
  update(from, to, t) {
    const d = this._d.subVectors(to, from), len = d.length();
    if (len < 0.01) { this.hide(); return; }
    this.mesh.position.copy(from).addScaledVector(d, 0.5);
    this.mesh.quaternion.setFromUnitVectors(this._up, d.normalize());
    const w = 1 + Math.sin(t * 40) * 0.35;
    this.mesh.scale.set(w, len, w);
    this.a.position.copy(from); this.b.position.copy(to);
    this.b.scale.setScalar(0.4 + Math.sin(t * 30) * 0.08);
    this.parts.forEach(o => { o.visible = true; });
  }
  hide() { this.parts.forEach(o => { o.visible = false; }); }
}
