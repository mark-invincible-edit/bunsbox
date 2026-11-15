// effects.js - glowing sparks + explosion picture flash, plus the physgun beam.
import * as THREE from 'three';
import { EXPLOSION_IMAGES } from './config.js';

let glowTex = null, boomTex = null;

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

const additive = (map, color) => new THREE.SpriteMaterial({ map, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
const FLASH_TIME = 0.22;

export class Effects {
  constructor(parent) {
    this.parent = parent; this.items = []; this.shake = 0;
    this.flash = new THREE.PointLight(0xffa040, 0, 80, 2);    // permanent so shaders never recompile mid-game
    parent.add(this.flash);
  }

  explosion(pos, radius) {
    const p = new THREE.Vector3(pos.x, pos.y, pos.z);

    // the picture: pops up big for a split second
    const tex = boomTex || getGlowTexture();
    const fm = additive(tex, boomTex ? 0xffffff : 0xffa040);
    const flash = new THREE.Sprite(fm);
    flash.position.copy(p);
    this.parent.add(flash);
    const aspect = boomTex?.image ? boomTex.image.width / boomTex.image.height : 1;

    // glowing sparks (one shared material per colour, sprites shrink instead of fading individually)
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
        sp.s.scale.setScalar(sp.size0 * (0.25 + (1 - it.t / sp.life)) * (0.8 + Math.random() * 0.4));   // twinkle + shrink
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
