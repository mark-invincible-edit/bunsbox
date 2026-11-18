// items.js - inventory items: definitions, models, inventory list, first-person viewmodel.
//
// MODEL RULE: every item model's long axis should point along +Y with the business end up (gun: barrel up).
// if your glb is oriented differently, fix it with modelRot - EULER DEGREES, [x, y, z]. length auto-fits the largest side.
// fp   = where it sits in first person (camera space: +x right, +y up, -z forward) + rotation (radians)
// hand = offset/rotation relative to the right hand bone (bone +Y points along the fingers on mixamo rigs) (radians)
// gun  = name of a block in ITEMS_CFG (config.js) - marks the item as a gun
import * as THREE from 'three';
import { cloneModel } from './assets.js';

export const ITEMS = {
  crowbar: {
    name: 'Crowbar', glb: 'models/crowbar.glb', length: 0.75, modelRot: [0, 180, 0], color: 0xc0392b,
    fp: { pos: [0.32, -0.3, -0.55], rot: [-1.0, 0.25, 0.45] }, hand: { pos: [0, 0.05, 0], rot: [0, 0, 0] },
    hint: 'LMB: swing (damages players/npcs, knocks props, sets off explosives)',
  },
  physgun: {
    name: 'Physics Gun', glb: 'models/physgun.glb', length: 0.55, modelRot: [90, 0, 0], color: 0xd0d4da,
    fp: { pos: [0.24, -0.22, -0.5], rot: [-Math.PI / 2, 0, 0] }, hand: { pos: [0, 0.05, 0.03], rot: [0, 0, 0] },
    hint: 'hold LMB: grab a prop - scroll while holding: distance',
  },
  glue: {
    name: 'Glue', glb: 'models/glue.glb', length: 0.28, modelRot: [0, 0, 0], color: 0xf5f5f5,
    fp: { pos: [0.22, -0.2, -0.45], rot: [-1.2, 0, 0.2] }, hand: { pos: [0, 0.04, 0], rot: [0, 0, 0] },
    hint: 'LMB: pick prop 1, then prop 2 to glue them - RMB: cancel / unglue aimed prop',
  },
  hinge: {
    name: 'Hinge', glb: 'models/hinge.glb', length: 0.22, modelRot: [0, 0, 0], color: 0xaab0b8,
    fp: { pos: [0.22, -0.2, -0.45], rot: [-1.2, 0, 0.2] }, hand: { pos: [0, 0.04, 0], rot: [0, 0, 0] },
    hint: 'LMB prop 1, then LMB where prop 2 / a wall meets it (must be close) - RMB: cancel / remove joints',
  },
  gun: {
    name: 'Gun', glb: 'models/gun.glb', length: 0.38, modelRot: [90, -90, 0], color: 0x2b2f36, gun: 'GUN',
    fp: { pos: [0.22, -0.4, -0.48], rot: [-Math.PI / 2, 0, 0] }, hand: { pos: [0, 0.05, 0.02], rot: [0, 0, 0] },
    hint: 'hold LMB: shoot (hurts players/npcs, nudges props)',
  },
  supergun: {
    name: 'Super Gun', glb: 'models/supergun.glb', length: 0.5, modelRot: [90, -90, 0], color: 0xe8b41e, gun: 'SUPERGUN',
    fp: { pos: [0.22, -1, -0.5], rot: [-Math.PI / 2, 0, 0] }, hand: { pos: [0, 0.05, 0.02], rot: [0, 0, 0] },
    hint: 'hold LMB: OP gun (huge damage, launches props)',
  },
};

// ---- model building (glb if it loaded, procedural fallback otherwise) ----
const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.2, ...extra });

function procedural(id, def) {
  const g = new THREE.Group(), L = def.length;
  const add = (geo, m, x = 0, y = 0, z = 0, rz = 0) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); o.rotation.z = rz; g.add(o); return o; };
  if (id === 'crowbar') {
    add(new THREE.BoxGeometry(0.035, L, 0.035), mat(def.color), 0, 0, 0);
    add(new THREE.BoxGeometry(0.035, 0.16, 0.035), mat(def.color), 0.04, L / 2 - 0.05, 0, -0.9);
    add(new THREE.BoxGeometry(0.035, 0.1, 0.035), mat(def.color), -0.02, -L / 2 + 0.03, 0, 0.5);
  } else if (id === 'physgun') {
    add(new THREE.BoxGeometry(0.1, L * 0.65, 0.1), mat(def.color), 0, -L * 0.15, 0);
    add(new THREE.BoxGeometry(0.045, L * 0.4, 0.045), mat(0xe8812a, { emissive: 0x6a2f00 }), 0, L * 0.3, 0);
    add(new THREE.SphereGeometry(0.035, 12, 8), new THREE.MeshBasicMaterial({ color: 0x4db8ff }), 0, L / 2, 0);
  } else if (id === 'gun' || id === 'supergun') {
    add(new THREE.BoxGeometry(0.045, L * 0.85, 0.07), mat(def.color), 0, L * 0.05, 0);            // slide + barrel along +Y
    add(new THREE.BoxGeometry(0.04, 0.09, 0.11), mat(0x3a2a1a), 0, -L * 0.25, -0.075);              // grip hangs down (-z)
    add(new THREE.BoxGeometry(0.018, 0.04, 0.018), mat(0x111111), 0, L * 0.42, 0.045);             // front sight
    if (id === 'supergun') add(new THREE.BoxGeometry(0.05, L * 0.55, 0.012), new THREE.MeshBasicMaterial({ color: 0xffcc33 }), 0, L * 0.05, 0.04);
  } else if (id === 'hinge') {
    add(new THREE.BoxGeometry(0.012, L, 0.07), mat(0xaab0b8), -0.03, 0, 0);
    add(new THREE.BoxGeometry(0.012, L, 0.07), mat(0xaab0b8), 0.03, 0, 0);
    add(new THREE.CylinderGeometry(0.014, 0.014, L * 1.05, 10), mat(0x555a62), 0, 0, 0);
  } else {   // glue
    add(new THREE.CylinderGeometry(0.04, 0.04, L * 0.75, 12), mat(def.color), 0, -L * 0.1, 0);
    add(new THREE.CylinderGeometry(0.018, 0.028, L * 0.25, 12), mat(0xe8812a), 0, L * 0.4, 0);
  }
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return g;
}

export function buildItemModel(id) {
  const def = ITEMS[id], g = new THREE.Group();
  const inst = def.glb ? cloneModel(def.glb) : null;
  if (inst) {
    const pre = new THREE.Group();
    pre.add(inst.object);
    pre.rotation.set(...def.modelRot.map(THREE.MathUtils.degToRad));      // modelRot is in degrees
    pre.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(pre), size = box.getSize(new THREE.Vector3());
    const s = def.length / (Math.max(size.x, size.y, size.z) || 1), c = box.getCenter(new THREE.Vector3());
    pre.scale.setScalar(s);
    pre.position.copy(c).multiplyScalar(-s);
    inst.object.traverse(o => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
    g.add(pre);
  } else g.add(procedural(id, def));
  const tip = new THREE.Object3D();
  tip.position.y = def.length / 2;              // physgun beam start / gun muzzle
  g.add(tip);
  g.userData.tip = tip;
  return g;
}

// ---- inventory: slot 0 is always empty hands ----
export class Inventory {
  constructor(onChange) { this.list = [null]; this.sel = 0; this.onChange = onChange; }
  get current() { return this.list[this.sel]; }
  has(id) { return this.list.includes(id); }
  add(id) { if (this.has(id)) return false; this.list.push(id); this.sel = this.list.length - 1; this.onChange(); return true; }
  cycle(dir) { if (this.list.length < 2) return; this.sel = (this.sel + dir + this.list.length) % this.list.length; this.onChange(); }
}

// ---- first person viewmodel (child of the camera) ----
export class ViewModel {
  constructor(camera) {
    this.camera = camera; this.root = new THREE.Group(); camera.add(this.root);
    this.model = null; this.def = null; this.raise = 0; this.swing = 0; this.recoil = 0; this.bobT = 0;
  }
  set(id) {
    if (this.model) { this.root.remove(this.model); this.model = null; }
    if (!id) return;
    this.def = ITEMS[id];
    this.model = buildItemModel(id);
    this.model.traverse(o => { if (o.isMesh) { o.castShadow = false; o.frustumCulled = false; } });
    this.root.add(this.model);
    this.raise = 1;            // pull-out animation
  }
  swingNow() { this.swing = 1; }
  recoilNow() { this.recoil = 1; }
  tip(out) { const t = this.model?.userData.tip; return t ? t.getWorldPosition(out) : null; }
  update(dt, speed, visible) {
    this.root.visible = visible && !!this.model;
    if (!this.model) return;
    this.bobT += dt * (4 + speed * 1.2);
    const amp = Math.min(speed / 6, 1);
    this.raise = Math.max(0, this.raise - dt * 4.5);
    this.swing = Math.max(0, this.swing - dt * 3.6);
    this.recoil = Math.max(0, this.recoil - dt * 12);
    const b = this.def.fp, arc = Math.sin(this.swing * Math.PI), r = this.raise * this.raise;
    this.model.position.set(
      b.pos[0] + Math.sin(this.bobT * 0.5) * 0.012 * amp,
      b.pos[1] - r * 0.4 + Math.abs(Math.sin(this.bobT)) * 0.01 * amp - arc * 0.05,
      b.pos[2] - arc * 0.15 + this.recoil * 0.06);
    this.model.rotation.set(b.rot[0] - arc * 1.3 + this.recoil * 0.14, b.rot[1] + arc * 0.2, b.rot[2]);
  }
}
