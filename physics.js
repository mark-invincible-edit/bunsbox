// physics.js - cannon-es world. the host / singleplayer simulates props; clients only mirror them
// (kinematic bodies driven by snapshots) so the client player can still stand on / bump into them.
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { PLAYER, GROUPS, LIMITS, ITEMS_CFG as IC, NEXTBOT, VEHICLE } from './config.js';
import { getSpawnable } from './spawnables.js';
import { cloneModel, makePlaceholder } from './assets.js';
import { buildItemModel } from './items.js';
import { SnapshotBuffer } from './interp.js';
import { safeImageUrl, loadImage } from './imgutil.js';
import { partMesh, specFromPart } from './mapfile.js';
import { buildVehicleVisual } from './vehicles.js';

const r3 = v => Math.round(v * 1000) / 1000;
const UP = new THREE.Vector3(0, 1, 0);
const sat = (v, a, b) => Math.max(a, Math.min(b, v));
const _F = new CANNON.Vec3(), _R = new CANNON.Vec3(), _U = new CANNON.Vec3();
const _LF = new CANNON.Vec3(0, 0, -1), _LR = new CANNON.Vec3(1, 0, 0), _LU = new CANNON.Vec3(0, 1, 0);

// ---------------------------------------------------------------- nextbot sprite
function questionTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d');
  x.fillStyle = '#7a1020'; x.fillRect(0, 0, 128, 128);
  x.fillStyle = '#fff'; x.font = 'bold 96px sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('?', 64, 70);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function nextbotSprite(data) {
  const mat = new THREE.SpriteMaterial({ map: questionTexture(), transparent: true, alphaTest: 0.02 });
  const s = new THREE.Sprite(mat);
  s.scale.set(NEXTBOT.SIZE, NEXTBOT.SIZE, 1);
  s.position.y = NEXTBOT.SIZE / 2 - 0.6;          // sprite bottom sits on the ground under the 0.6 radius body
  if (safeImageUrl(data?.url)) {
    loadImage(data.url).then(img => {
      const t = new THREE.Texture(img); t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true;
      mat.map = t; mat.needsUpdate = true;
      const aspect = Math.max(0.3, Math.min(3, (img.naturalWidth / img.naturalHeight) || 1));
      s.scale.set(NEXTBOT.SIZE * aspect, NEXTBOT.SIZE, 1);
    }).catch(() => { /* keeps the ? texture */ });
  }
  return s;
}

// ---------------------------------------------------------------- visuals (also used for spawn menu previews + the map builder)
export function buildVisual(spec, data = null) {
  const holder = new THREE.Group();
  if (spec.part) { holder.add(partMesh(spec.part)); return holder; }       // custom map part
  if (spec.nextbot) { holder.add(nextbotSprite(data)); return holder; }
  if (spec.item) {                                   // inventory items: auto-fitted model (or procedural), lying flat
    const m = buildItemModel(spec.item);
    m.rotation.z = Math.PI / 2;
    holder.add(m);
    return holder;
  }
  if (spec.vehicle) {                                // procedural car/truck/kart, or a glb fitted to the collider
    const m = spec.glb ? cloneModel(spec.glb) : null;
    const v = buildVehicleVisual(spec, m ? m.object : null);
    holder.add(v); holder.userData.veh = v.userData.veh;
    return holder;
  }
  const inst = spec.glb ? cloneModel(spec.glb) : null;
  if (inst) {
    const o = inst.object;
    o.scale.multiplyScalar(spec.scale ?? 1);
    holder.add(o);
    holder.updateMatrixWorld(true);
    const c = new THREE.Box3().setFromObject(holder).getCenter(new THREE.Vector3());
    o.position.sub(c);                               // center the model on the physics body
    o.traverse(m => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
  } else {
    holder.add(makePlaceholder({ shape: spec.shape, size: spec.size, color: spec.color, label: spec.name }));
  }
  if (spec.thruster) {
    const dir = new THREE.Vector3(...spec.thruster.dir).normalize();
    const ext = Math.abs(dir.x) * spec.size[0] + Math.abs(dir.y) * spec.size[1] + Math.abs(dir.z || 0) * (spec.size[2] ?? 0);
    if (!inst) {                                     // arrow so you can see which way a placeholder pushes
      const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.22, 12), new THREE.MeshBasicMaterial({ color: 0x4de1ff }));
      arrow.quaternion.setFromUnitVectors(UP, dir);
      arrow.position.copy(dir).multiplyScalar(ext + 0.11);
      holder.add(arrow);
    }
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.7, 10),
      new THREE.MeshBasicMaterial({ color: 0xff9a2e, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
    flame.quaternion.setFromUnitVectors(UP, dir.clone().negate());   // apex points away from the nozzle
    flame.position.copy(dir).multiplyScalar(-(ext + 0.35));
    flame.visible = false;
    holder.add(flame);
    holder.userData.flame = flame;
  }
  return holder;
}

// ---------------------------------------------------------------- world
export class Physics {
  constructor(group, isAuthority) {
    this.group = group;
    this.isAuthority = isAuthority;
    this.hooks = {};            // onSpawn(prop) onRemove(id) onClear() onExplosion(pos, ex) onThruster(id, on)
    this.props = new Map();
    this.remote = new Map();    // host only: kinematic bodies for remote players so they can push props
    this.timers = [];           // {t, id} fuses + chain reactions
    this.grabs = new Map();     // physgun: owner id -> {id, target:[x,y,z]}
    this.joints = [];           // {kind:'glue'|'hinge', a, b|null, c, anchor|null}
    this.nextId = 1;
    this.time = 0;              // seconds simulated, used for driver input timeouts
    this._v = new CANNON.Vec3();

    const w = (this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, PLAYER.GRAVITY, 0) }));
    w.allowSleep = true;
    w.solver.iterations = 12;
    this.groundMat = new CANNON.Material('ground');
    this.playerMat = new CANNON.Material('player');
    this.propMat = new CANNON.Material('prop');
    this.bouncyMat = new CANNON.Material('bouncy');
    this.vehMat = new CANNON.Material('vehicle');
    const cm = (a, b, o) => w.addContactMaterial(new CANNON.ContactMaterial(a, b, o));
    cm(this.playerMat, this.groundMat, { friction: 0, restitution: 0 });     // zero friction: we drive velocity ourselves
    cm(this.playerMat, this.propMat, { friction: 0.05, restitution: 0 });
    cm(this.playerMat, this.bouncyMat, { friction: 0.05, restitution: 0 });
    cm(this.playerMat, this.playerMat, { friction: 0, restitution: 0 });
    cm(this.propMat, this.groundMat, { friction: 0.5, restitution: 0.1 });
    cm(this.bouncyMat, this.groundMat, { friction: 0.4, restitution: 0.75 });
    cm(this.propMat, this.propMat, { friction: 0.4, restitution: 0.1 });
    cm(this.bouncyMat, this.propMat, { friction: 0.4, restitution: 0.5 });
    cm(this.bouncyMat, this.bouncyMat, { friction: 0.4, restitution: 0.75 });
    // vehicles get ZERO wheel friction: cannon applies friction per contact point (4 wheels = 4x the drag, ~7-10 m/s^2),
    // which swallowed the engine. the drive code does its own grip, drag and braking.
    cm(this.vehMat, this.groundMat, { friction: 0, restitution: 0.02 });
    cm(this.vehMat, this.propMat, { friction: 0.05, restitution: 0.1 });
    cm(this.vehMat, this.bouncyMat, { friction: 0.05, restitution: 0.4 });
    cm(this.vehMat, this.vehMat, { friction: 0.05, restitution: 0.1 });
    cm(this.vehMat, this.playerMat, { friction: 0, restitution: 0 });
  }

  // ---- static world ----
  _static(shape, pos, surface, quat) {
    const b = new CANNON.Body({ mass: 0, material: this.groundMat, collisionFilterGroup: GROUPS.WORLD, collisionFilterMask: GROUPS.PLAYER | GROUPS.PROP });
    b.addShape(shape);
    b.position.set(pos[0], pos[1], pos[2]);
    if (quat) b.quaternion.set(quat.x, quat.y, quat.z, quat.w);
    b.surface = surface;
    this.world.addBody(b);
  }
  addStaticBox(size, pos, quat, surface) { this._static(new CANNON.Box(new CANNON.Vec3(size[0] / 2, size[1] / 2, size[2] / 2)), pos, surface, quat); }
  addStaticSphere(radius, pos, surface) { this._static(new CANNON.Sphere(radius), pos, surface, null); }

  // two spheres stacked = cheap capsule. body origin is at the player's FEET. (npcs use this too)
  createPlayerBody() {
    const b = new CANNON.Body({ mass: 80, material: this.playerMat, fixedRotation: true, linearDamping: 0.01, allowSleep: false,
      collisionFilterGroup: GROUPS.PLAYER, collisionFilterMask: GROUPS.WORLD | GROUPS.PROP });
    b.addShape(new CANNON.Sphere(0.45), new CANNON.Vec3(0, 0.45, 0));
    b.addShape(new CANNON.Sphere(0.4), new CANNON.Vec3(0, 1.3, 0));
    b.updateMassProperties();
    this.world.addBody(b);
    return b;
  }
  removeBody(b) { this.world.removeBody(b); }

  addRemoteBody(id) {
    if (this.remote.has(id)) return;
    const b = new CANNON.Body({ type: CANNON.Body.KINEMATIC, material: this.playerMat, collisionFilterGroup: GROUPS.REMOTE, collisionFilterMask: GROUPS.PROP });
    b.addShape(new CANNON.Sphere(0.45), new CANNON.Vec3(0, 0.45, 0));
    b.addShape(new CANNON.Sphere(0.4), new CANNON.Vec3(0, 1.3, 0));
    this.world.addBody(b);
    this.remote.set(id, b);
  }
  moveRemoteBody(id, pos, dt) {
    const b = this.remote.get(id);
    if (!b) return;
    if (dt > 0) {
      const v = new CANNON.Vec3((pos.x - b.position.x) / dt, (pos.y - b.position.y) / dt, (pos.z - b.position.z) / dt);
      const l = v.length();
      if (l > 15) v.scale(15 / l, v);     // teleports must not launch props
      b.velocity.copy(v);
    }
    b.position.set(pos.x, pos.y, pos.z);
  }
  removeRemoteBody(id) { const b = this.remote.get(id); if (b) { this.world.removeBody(b); this.remote.delete(id); } }

  // ---- queries ----
  raycast(from, to, mask = GROUPS.WORLD | GROUPS.PROP) {
    const res = new CANNON.RaycastResult();
    this.world.raycastClosest(from, to, { collisionFilterMask: mask, skipBackfaces: true }, res);
    return res.hasHit ? res : null;
  }
  raycastRay(o, d, dist = LIMITS.REACH, mask) {
    const res = this.raycast(new CANNON.Vec3(o.x, o.y, o.z), new CANNON.Vec3(o.x + d.x * dist, o.y + d.y * dist, o.z + d.z * dist), mask);
    if (!res) return null;
    const p = res.hitPointWorld, n = res.hitNormalWorld;
    return { point: { x: p.x, y: p.y, z: p.z }, normal: { x: n.x, y: n.y, z: n.z }, body: res.body, dist: res.distance };
  }

  // ---- props ----
  // opts: { id, owner, quat:[x,y,z,w], silent, data, force (ignore prop limit), anchored (static body), mass, bouncy, map (part of the map file) }
  // key '__part' = a custom map part, its definition travels in opts.data.part
  spawnProp(key, pos, yaw = 0, opts = {}) {
    const spec = key === '__part' ? (opts.data?.part ? specFromPart(opts.data.part) : null) : getSpawnable(key);
    if (!spec || spec.npc) { console.warn(`[physics] cannot spawn as prop: ${key}`); return null; }
    if (this.isAuthority && !opts.force && this.props.size >= LIMITS.MAX_PROPS) return null;
    const id = opts.id ?? this.nextId++;
    if (id >= this.nextId) this.nextId = id + 1;
    const anchored = !!opts.anchored, bouncy = opts.bouncy ?? spec.bouncy;

    const body = new CANNON.Body({
      type: anchored ? CANNON.Body.STATIC : (this.isAuthority ? CANNON.Body.DYNAMIC : CANNON.Body.KINEMATIC),
      mass: (anchored || !this.isAuthority) ? 0 : (opts.mass ?? spec.mass),
      material: spec.vehicle ? this.vehMat : bouncy ? this.bouncyMat : this.propMat,
      linearDamping: spec.vehicle ? 0.02 : 0.05, angularDamping: spec.vehicle ? 0.6 : 0.25,
      allowSleep: !spec.nextbot, sleepSpeedLimit: 0.2, sleepTimeLimit: 1,
      fixedRotation: !!spec.nextbot,                  // nextbots never tumble (their sprite is an offset billboard)
      collisionFilterGroup: GROUPS.PROP,
      collisionFilterMask: GROUPS.WORLD | GROUPS.PROP | GROUPS.REMOTE | GROUPS.PLAYER,
    });
    body.addShape(spec.shape === 'sphere' ? new CANNON.Sphere(spec.size[0]) : new CANNON.Box(new CANNON.Vec3(...spec.size)));
    if (spec.vehicle) {                               // wheels are spheres tucked inside the visual wheel width: they roll over small bumps
      const vc = spec.vehicle;
      for (const w of vc.wheels) body.addShape(new CANNON.Sphere(vc.wheelR), new CANNON.Vec3(w[0] + Math.sign(w[0]) * (vc.wheelW / 2 - vc.wheelR), w[1], w[2]));
    }
    body.position.set(pos[0], pos[1], pos[2]);
    if (opts.quat && !spec.nextbot) body.quaternion.set(...opts.quat); else body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), spec.nextbot ? 0 : yaw);
    if (spec.nextbot) body.updateMassProperties();
    body.propId = id;

    const mesh = buildVisual(spec, opts.data || null);
    mesh.position.copy(body.position); mesh.quaternion.copy(body.quaternion);
    this.group.add(mesh);
    this.world.addBody(body);

    const prop = { id, key, spec, body, mesh, owner: opts.owner ?? 0, data: opts.data || null, buf: new SnapshotBuffer(),
      sentSleep: false, chained: false, active: false, anchored, map: !!opts.map, flame: mesh.userData.flame || null,
      scale: 1, baseMass: body.mass, driver: null, input: [0, 0, 0], inputT: 0, flipT: 0 };
    this.props.set(id, prop);

    if (this.isAuthority && spec.explosive) {
      if (spec.explosive.fuse) this.timers.push({ t: spec.explosive.fuse, id });
      if (spec.explosive.impact) {
        body.addEventListener('collide', e => {
          if (e.contact.getImpactVelocityAlongNormal() > spec.explosive.impact) this.timers.push({ t: 0, id });
        });
      }
    }
    if (!opts.silent) this.hooks.onSpawn?.(prop);
    return prop;
  }

  removeProp(id, silent = false) {
    const p = this.props.get(id);
    if (!p) return false;
    if (p.driver !== null) this.setDriver(id, null);
    this.unglue(id);
    for (const [o, g] of [...this.grabs]) if (g.id === id) this.grabs.delete(o);
    this.world.removeBody(p.body);
    this.group.remove(p.mesh);
    this.props.delete(id);
    if (!silent) this.hooks.onRemove?.(id);
    return true;
  }
  // "clear all" leaves props that belong to the map file alone
  clearProps() {
    for (const j of this.joints) this._dropJoint(j);
    this.joints = []; this.grabs.clear();
    for (const p of [...this.props.values()]) if (!p.map) this.removeProp(p.id, true);
    this.timers.length = 0;
    this.hooks.onClear?.();
  }

  // ---- interactions (authority only) ----
  knockProp(id, d, mag) {
    const p = this.props.get(id);
    if (!this.isAuthority || !p || p.anchored) return;
    const l = Math.hypot(d.x, d.y, d.z) || 1, dv = Math.min(14, mag / p.body.mass);
    p.body.wakeUp();
    p.body.velocity.x += d.x / l * dv; p.body.velocity.y += d.y / l * dv + dv * 0.15; p.body.velocity.z += d.z / l * dv;
    p.body.angularVelocity.set((Math.random() - 0.5) * dv * 0.4, (Math.random() - 0.5) * dv * 0.4, (Math.random() - 0.5) * dv * 0.4);
  }

  toggleThruster(id) {
    const p = this.props.get(id);
    if (!p || !p.spec.thruster) return;
    p.active = !p.active;
    this.hooks.onThruster?.(id, p.active);
  }
  setThruster(id, on) { const p = this.props.get(id); if (p) p.active = on; }     // clients: visual only

  startGrab(owner, id) { const p = this.props.get(id); if (this.isAuthority && p && !p.anchored) this.grabs.set(owner, { id, target: [p.body.position.x, p.body.position.y, p.body.position.z] }); }
  setGrabTarget(owner, t) { const g = this.grabs.get(owner); if (g) g.target = t; }
  endGrab(owner) { this.grabs.delete(owner); }

  // ---- scaling (authority decides, clients mirror it from the 'scl' message) ----
  scaleBy(id, f) { const p = this.props.get(id); return p ? this.setScale(id, p.scale * f) : false; }
  setScale(id, s) {
    const p = this.props.get(id);
    if (!p || p.spec.nextbot || p.spec.vehicle || !Number.isFinite(s)) return false;
    s = sat(s, IC.SCALER.MIN, IC.SCALER.MAX);
    if (Math.abs(s - p.scale) < 1e-4) return false;
    const sp = p.spec, b = p.body, sh = b.shapes[0];
    if (sp.shape === 'sphere') sh.radius = sp.size[0] * s;
    else { sh.halfExtents.set(sp.size[0] * s, sp.size[1] * s, sp.size[2] * s); sh.updateConvexPolyhedronRepresentation(); }
    sh.updateBoundingSphereRadius();
    b.updateBoundingRadius(); b.aabbNeedsUpdate = true;
    if (b.type === CANNON.Body.DYNAMIC) { b.mass = Math.max(0.05, p.baseMass * s * s * s); b.updateMassProperties(); }
    b.wakeUp();
    p.mesh.scale.setScalar(s);
    p.scale = s;
    this.hooks.onScale?.(id, s);
    return true;
  }

  // ---- vehicles ----
  // owner: 0 = the host / singleplayer player, otherwise a client id. null frees the seat. returns false if somebody else is driving
  setDriver(id, owner) {
    const p = this.props.get(id);
    if (!p || !p.spec.vehicle) return false;
    if (owner !== null && p.driver !== null && p.driver !== owner) return false;
    const prev = p.driver;
    p.driver = owner;
    if (prev !== null && prev !== 0) { const rb = this.remote.get(prev); if (rb) rb.collisionFilterMask = GROUPS.PROP; }
    if (owner !== null && owner !== 0) { const rb = this.remote.get(owner); if (rb) rb.collisionFilterMask = 0; }   // the driver's body sits inside the car: it must not push it
    p.input = [0, 0, 0]; p.inputT = this.time; p.flipT = 0;
    p.body.wakeUp();
    return true;
  }
  releaseDriversOf(owner) { for (const p of [...this.props.values()]) if (p.driver === owner) this.setDriver(p.id, null); }
  setDriveInput(id, owner, i) {
    const p = this.props.get(id);
    if (!p || p.driver !== owner) return;
    p.input = [sat(Number(i[0]) || 0, -1, 1), sat(Number(i[1]) || 0, -1, 1), i[2] ? 1 : 0];
    p.inputT = this.time;
  }

  // how many wheels are touching something walkable (rays from each wheel, skipping the car itself)
  _wheelsDown(p) {
    const vc = p.spec.vehicle, b = p.body, group = b.collisionFilterGroup;
    b.collisionFilterGroup = 64;                      // out of the ray mask so the car does not hit itself
    let n = 0;
    try {
      for (const w of vc.wheels) {
        const from = b.pointToWorldFrame(new CANNON.Vec3(w[0], w[1], w[2]), new CANNON.Vec3());
        const to = new CANNON.Vec3(from.x, from.y - (vc.wheelR + 0.25), from.z);
        const res = new CANNON.RaycastResult();
        this.world.raycastClosest(from, to, { collisionFilterMask: GROUPS.WORLD | GROUPS.PROP, skipBackfaces: true }, res);
        if (res.hasHit && res.hitNormalWorld.y > 0.3) n++;
      }
    } finally { b.collisionFilterGroup = group; }
    return n;
  }

  // backup ground check from the last step's contacts: something below the car pushing up on it
  _supported(b) {
    for (const c of this.world.contacts) {
      const mine = c.bi === b, theirs = c.bj === b;
      if (!mine && !theirs) continue;
      const other = mine ? c.bj : c.bi;
      if (other.collisionFilterGroup === GROUPS.PLAYER || other.collisionFilterGroup === GROUPS.REMOTE) continue;
      if ((mine ? -c.ni.y : c.ni.y) > 0.3) return true;       // ni points from bi to bj
    }
    return false;
  }

  _driveVehicles(dt) {
    const V = VEHICLE;
    for (const p of this.props.values()) {
      const vc = p.spec.vehicle;
      if (!vc || p.anchored) continue;
      const b = p.body, manned = p.driver !== null;
      if (manned) b.wakeUp(); else if (b.sleepState === CANNON.Body.SLEEPING) continue;
      const live = manned && this.time - p.inputT < V.INPUT_TIMEOUT;
      const thr = live ? p.input[0] : 0, str = live ? p.input[1] : 0, brk = live ? p.input[2] : 0;
      const grounded = this._wheelsDown(p) > 0 || this._supported(b);
      const q = b.quaternion, v = b.velocity;
      q.vmult(_LF, _F); q.vmult(_LR, _R); q.vmult(_LU, _U);
      const vf = v.x * _F.x + v.y * _F.y + v.z * _F.z, vr = v.x * _R.x + v.y * _R.y + v.z * _R.z;

      if (grounded) {
        let dv = 0;                                                             // acceleration along the facing
        if (thr > 0) { if (vf < vc.max) dv = vc.accel * thr * dt; }
        else if (thr < 0) dv = vf > 0.5 ? -vc.accel * 1.6 * dt : (vf > -vc.reverse ? vc.accel * thr * 0.8 * dt : 0);   // s brakes first, then reverses
        v.x += _F.x * dv; v.y += _F.y * dv; v.z += _F.z * dv;
        let kf = 0;
        if (thr === 0) kf = 1 - Math.exp(-0.45 * dt);                           // coasting
        if (brk) kf = Math.max(kf, 1 - Math.exp(-4.5 * dt));                    // handbrake
        v.x -= _F.x * vf * kf; v.y -= _F.y * vf * kf; v.z -= _F.z * vf * kf;
        const kg = 1 - Math.exp(-(brk ? vc.grip * 0.3 : vc.grip) * dt);         // sideways grip (handbrake = drift)
        v.x -= _R.x * vr * kg; v.y -= _R.y * vr * kg; v.z -= _R.z * vr * kg;
        if (!manned) { const k = Math.exp(-2.5 * dt); v.x *= k; v.z *= k; }     // parked cars do not roll away

        const sf = sat(vf / (vc.steerSpeed || 5), -1, 1) * (1 - 0.45 * sat(Math.abs(vf) / vc.max, 0, 1));
        b.angularVelocity.y += (-str * vc.steer * sf - b.angularVelocity.y) * (1 - Math.exp(-8 * dt));
        if (_U.y < 0.78) {                                                      // tipped far over: roll back toward upright
          const k = 1 - Math.exp(-5 * dt);
          b.angularVelocity.x += (-_U.z * 4 - b.angularVelocity.x) * k;
          b.angularVelocity.z += (_U.x * 4 - b.angularVelocity.z) * k;
        }
      }
      if (manned && _U.y < 0.3 && Math.hypot(v.x, v.z) < 3) {                   // flipped over with a driver: put it back on its wheels
        p.flipT += dt;
        if (p.flipT > V.FLIP_TIME) {
          p.flipT = 0;
          b.quaternion.setFromAxisAngle(_LU, Math.atan2(-_F.x, -_F.z));
          b.position.y += 1.2;
          b.velocity.set(0, 0, 0); b.angularVelocity.set(0, 0, 0);
        }
      } else p.flipT = 0;
    }
  }

  // ---- joints ----
  _dropJoint(j) {
    this.world.removeConstraint(j.c);
    if (j.anchor) this.world.removeBody(j.anchor);
  }

  glue(a, b) {
    if (!this.isAuthority || a === b) return false;
    const pa = this.props.get(a), pb = this.props.get(b);
    if (!pa || !pb) return false;
    if (this.joints.some(g => g.kind === 'glue' && ((g.a === a && g.b === b) || (g.a === b && g.b === a)))) return false;
    const c = new CANNON.LockConstraint(pa.body, pb.body, { collideConnected: false });
    this.world.addConstraint(c);
    this.joints.push({ kind: 'glue', a, b, c, anchor: null });
    pa.body.wakeUp(); pb.body.wakeUp();
    return true;
  }

  // door-style hinge (vertical axis). p1/p2 = the two points the player aimed at: they must be close together.
  // bId = null pins prop a to the world. returns null on success or an error string.
  hinge(a, bId, p1, p2) {
    if (!this.isAuthority) return 'only the host can do that';
    const pa = this.props.get(a), pb = bId == null ? null : this.props.get(bId);
    if (!pa || (bId != null && !pb)) return 'that prop is gone';
    if (a === bId) return 'pick a different prop';
    const gap = Math.hypot(p1[0] - p2[0], p1[1] - p2[1], p1[2] - p2[2]);
    if (!(gap <= IC.HINGE.MAX_GAP)) return 'too far apart. move the props closer together';
    const mid = new CANNON.Vec3((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2, (p1[2] + p2[2]) / 2);
    if (mid.distanceTo(pa.body.position) > 8 || (pb && mid.distanceTo(pb.body.position) > 8)) return 'hinge point is not on those props';

    let anchor = null, bodyB = pb?.body;
    if (!bodyB) {                                   // pin to the world with an invisible static anchor
      anchor = new CANNON.Body({ mass: 0 });
      anchor.position.copy(mid);
      this.world.addBody(anchor);
      bodyB = anchor;
    }
    const axis = new CANNON.Vec3(0, 1, 0);
    const local = body => body.pointToLocalFrame(mid, new CANNON.Vec3());
    const localAxis = body => body.quaternion.inverse().vmult(axis, new CANNON.Vec3());
    const c = new CANNON.HingeConstraint(pa.body, bodyB, {
      pivotA: local(pa.body), axisA: localAxis(pa.body),
      pivotB: local(bodyB), axisB: localAxis(bodyB),
      collideConnected: false,
    });
    this.world.addConstraint(c);
    this.joints.push({ kind: 'hinge', a, b: bId ?? null, c, anchor });
    pa.body.wakeUp(); pb?.body.wakeUp();
    return null;
  }

  // remove every glue/hinge touching this prop
  unglue(id) {
    const keep = [];
    for (const j of this.joints) { if (j.a === id || j.b === id) this._dropJoint(j); else keep.push(j); }
    const changed = keep.length !== this.joints.length;
    this.joints = keep;
    return changed;
  }

  // ---- explosions (authority only) ----
  detonate(id) {
    const p = this.props.get(id);
    if (!this.isAuthority || !p || !p.spec.explosive) return;
    const pos = { x: p.body.position.x, y: p.body.position.y, z: p.body.position.z };
    this.removeProp(id);
    this.explode(pos, p.spec.explosive);
  }

  explode(pos, ex) {
    for (const p of this.props.values()) {
      const dx = p.body.position.x - pos.x, dy = p.body.position.y - pos.y, dz = p.body.position.z - pos.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > ex.radius) continue;
      const f = 1 - dist / ex.radius;
      if (p.spec.explosive && !p.chained && f > 0.35) { p.chained = true; this.timers.push({ t: 0.12 + Math.random() * 0.25, id: p.id }); }
      if (p.anchored) continue;
      let ux = dx / (dist || 1), uy = dy / (dist || 1) + 0.5, uz = dz / (dist || 1);
      const l = Math.hypot(ux, uy, uz);
      const dv = ex.force * f;
      p.body.wakeUp();
      p.body.velocity.x += ux / l * dv; p.body.velocity.y += uy / l * dv; p.body.velocity.z += uz / l * dv;
      p.body.angularVelocity.set((Math.random() - 0.5) * dv, (Math.random() - 0.5) * dv, (Math.random() - 0.5) * dv);
    }
    this.hooks.onExplosion?.(pos, ex);
  }

  // ---- stepping ----
  _preStep(dt) {
    const V = this._v;
    for (const [owner, g] of [...this.grabs]) {            // physgun: spring the prop to the target point
      const p = this.props.get(g.id);
      if (!p) { this.grabs.delete(owner); continue; }
      const b = p.body;
      b.wakeUp();
      let vx = (g.target[0] - b.position.x) * 14, vy = (g.target[1] - b.position.y) * 14, vz = (g.target[2] - b.position.z) * 14;
      const l = Math.hypot(vx, vy, vz);
      if (l > 30) { vx *= 30 / l; vy *= 30 / l; vz *= 30 / l; }
      b.velocity.set(vx, vy, vz);
      b.angularVelocity.scale(0.85, b.angularVelocity);
    }
    for (const p of this.props.values()) {                 // thrusters push along their facing
      if (!p.active || !p.spec.thruster || p.anchored) continue;
      const t = p.spec.thruster;
      V.set(t.dir[0], t.dir[1], t.dir[2]);
      p.body.quaternion.vmult(V, V);
      V.scale(t.thrust, V);
      p.body.wakeUp();
      p.body.applyForce(V);
    }
    this._driveVehicles(dt);
    for (const j of this.joints) {                         // never let half a joined pair fall asleep
      const a = this.props.get(j.a)?.body, b = j.b != null ? this.props.get(j.b)?.body : null;
      if (!a || !b) continue;
      if (a.sleepState === CANNON.Body.SLEEPING && b.sleepState !== CANNON.Body.SLEEPING) a.wakeUp();
      else if (b.sleepState === CANNON.Body.SLEEPING && a.sleepState !== CANNON.Body.SLEEPING) b.wakeUp();
    }
  }

  _flames() {
    for (const p of this.props.values()) {
      if (!p.flame) continue;
      p.flame.visible = p.active;
      if (p.active) p.flame.scale.set(0.85 + Math.random() * 0.3, 0.8 + Math.random() * 0.6, 0.85 + Math.random() * 0.3);
    }
  }

  step(dt) {
    this.time += dt;
    if (this.isAuthority) this._preStep(dt);
    this.world.step(1 / 60, dt, 3);
    this._flames();
    if (!this.isAuthority) return;
    for (const t of this.timers) t.t -= dt;
    const due = this.timers.filter(t => t.t <= 0);
    if (due.length) { this.timers = this.timers.filter(t => t.t > 0); for (const t of due) this.detonate(t.id); }
    for (const p of [...this.props.values()]) {
      if (p.anchored) continue;
      if (p.body.position.y < -60) { this.removeProp(p.id); continue; }
      p.mesh.position.copy(p.body.position);
      p.mesh.quaternion.copy(p.body.quaternion);
    }
  }

  // ---- network helpers ----
  // props that moved since last call (sleeping ones are sent once, then skipped; anchored ones never move)
  collectDelta() {
    const out = [];
    for (const p of this.props.values()) {
      if (p.anchored) continue;
      const sleeping = p.body.sleepState === CANNON.Body.SLEEPING;
      if (sleeping && p.sentSleep) continue;
      p.sentSleep = sleeping;
      const b = p.body;
      out.push([p.id, r3(b.position.x), r3(b.position.y), r3(b.position.z), r3(b.quaternion.x), r3(b.quaternion.y), r3(b.quaternion.z), r3(b.quaternion.w)]);
    }
    return out;
  }
  applyPropStates(list, t) {
    for (const e of list || []) { const p = this.props.get(e[0]); if (p) p.buf.push(t, [e[1], e[2], e[3]], [e[4], e[5], e[6], e[7]]); }
  }
  updateClient(renderTime) {
    for (const p of this.props.values()) {
      const s = p.buf.sample(renderTime);
      if (!s) continue;
      p.mesh.position.set(...s.p); p.mesh.quaternion.set(...s.q);
      p.body.position.set(...s.p); p.body.quaternion.set(...s.q);
    }
  }
}
