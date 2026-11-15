// physics.js - cannon-es world. the host / singleplayer simulates props; clients only mirror them
// (kinematic bodies driven by snapshots) so the client player can still stand on / bump into them.
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { PLAYER, GROUPS, LIMITS } from './config.js';
import { getSpawnable } from './spawnables.js';
import { cloneModel, makePlaceholder } from './assets.js';
import { buildItemModel } from './items.js';
import { SnapshotBuffer } from './interp.js';

const r3 = v => Math.round(v * 1000) / 1000;
const UP = new THREE.Vector3(0, 1, 0);

export class Physics {
  constructor(group, isAuthority) {
    this.group = group;
    this.isAuthority = isAuthority;
    this.hooks = {};            // onSpawn(prop) onRemove(id) onClear() onExplosion(pos, ex) onThruster(id, on)
    this.props = new Map();
    this.remote = new Map();    // host only: kinematic bodies for remote players so they can push props
    this.timers = [];           // {t, id} fuses + chain reactions
    this.grabs = new Map();     // physgun: owner id -> {id, target:[x,y,z]}
    this.glues = [];            // {a, b, c}
    this.nextId = 1;
    this._v = new CANNON.Vec3();

    const w = (this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, PLAYER.GRAVITY, 0) }));
    w.allowSleep = true;
    w.solver.iterations = 12;
    this.groundMat = new CANNON.Material('ground');
    this.playerMat = new CANNON.Material('player');
    this.propMat = new CANNON.Material('prop');
    this.bouncyMat = new CANNON.Material('bouncy');
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
  }

  // ---- static world ----
  addStaticBox(size, pos, quat, surface) {
    const b = new CANNON.Body({ mass: 0, material: this.groundMat, collisionFilterGroup: GROUPS.WORLD, collisionFilterMask: GROUPS.PLAYER | GROUPS.PROP });
    b.addShape(new CANNON.Box(new CANNON.Vec3(size[0] / 2, size[1] / 2, size[2] / 2)));
    b.position.set(pos[0], pos[1], pos[2]);
    b.quaternion.set(quat.x, quat.y, quat.z, quat.w);
    b.surface = surface;
    this.world.addBody(b);
  }

  // two spheres stacked = cheap capsule. body origin is at the player's FEET.
  createPlayerBody() {
    const b = new CANNON.Body({ mass: 80, material: this.playerMat, fixedRotation: true, linearDamping: 0.01, allowSleep: false,
      collisionFilterGroup: GROUPS.PLAYER, collisionFilterMask: GROUPS.WORLD | GROUPS.PROP });
    b.addShape(new CANNON.Sphere(0.45), new CANNON.Vec3(0, 0.45, 0));
    b.addShape(new CANNON.Sphere(0.4), new CANNON.Vec3(0, 1.3, 0));
    b.updateMassProperties();
    this.world.addBody(b);
    return b;
  }

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
  _visual(spec) {
    const holder = new THREE.Group();
    if (spec.item) {                                   // inventory items: auto-fitted model (or procedural), lying flat
      const m = buildItemModel(spec.item);
      m.rotation.z = Math.PI / 2;
      holder.add(m);
    } else {
      const inst = spec.glb ? cloneModel(spec.glb) : null;
      if (inst) {
        const o = inst.object;
        o.scale.multiplyScalar(spec.scale ?? 1);
        holder.add(o);
        holder.updateMatrixWorld(true);
        const c = new THREE.Box3().setFromObject(holder).getCenter(new THREE.Vector3());
        o.position.sub(c);                             // center the model on the physics body
        o.traverse(m => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
      } else {
        holder.add(makePlaceholder({ shape: spec.shape, size: spec.size, color: spec.color, label: spec.name }));
      }
      if (spec.thruster) {
        const dir = new THREE.Vector3(...spec.thruster.dir).normalize();
        const ext = Math.abs(dir.x) * spec.size[0] + Math.abs(dir.y) * spec.size[1] + Math.abs(dir.z || 0) * (spec.size[2] ?? 0);
        if (!inst) {                                   // arrow so you can see which way a placeholder pushes
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
    }
    return holder;
  }

  // opts: { id, owner, quat:[x,y,z,w], silent }
  spawnProp(key, pos, yaw = 0, opts = {}) {
    const spec = getSpawnable(key);
    if (!spec) { console.warn(`[physics] unknown spawnable: ${key}`); return null; }
    if (this.isAuthority && this.props.size >= LIMITS.MAX_PROPS) return null;
    const id = opts.id ?? this.nextId++;
    if (id >= this.nextId) this.nextId = id + 1;

    const body = new CANNON.Body({
      type: this.isAuthority ? CANNON.Body.DYNAMIC : CANNON.Body.KINEMATIC,
      mass: this.isAuthority ? spec.mass : 0,
      material: spec.bouncy ? this.bouncyMat : this.propMat,
      linearDamping: 0.05, angularDamping: 0.25,
      allowSleep: true, sleepSpeedLimit: 0.2, sleepTimeLimit: 1,
      collisionFilterGroup: GROUPS.PROP,
      collisionFilterMask: GROUPS.WORLD | GROUPS.PROP | GROUPS.REMOTE | GROUPS.PLAYER,
    });
    body.addShape(spec.shape === 'sphere' ? new CANNON.Sphere(spec.size[0]) : new CANNON.Box(new CANNON.Vec3(...spec.size)));
    body.position.set(pos[0], pos[1], pos[2]);
    if (opts.quat) body.quaternion.set(...opts.quat); else body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), yaw);
    body.propId = id;

    const mesh = this._visual(spec);
    mesh.position.copy(body.position); mesh.quaternion.copy(body.quaternion);
    this.group.add(mesh);
    this.world.addBody(body);

    const prop = { id, key, spec, body, mesh, owner: opts.owner ?? 0, buf: new SnapshotBuffer(), sentSleep: false, chained: false,
      active: false, flame: mesh.userData.flame || null };
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
    this.unglue(id);
    for (const [o, g] of [...this.grabs]) if (g.id === id) this.grabs.delete(o);
    this.world.removeBody(p.body);
    this.group.remove(p.mesh);
    this.props.delete(id);
    if (!silent) this.hooks.onRemove?.(id);
    return true;
  }
  clearProps() {
    for (const g of this.glues) this.world.removeConstraint(g.c);
    this.glues = []; this.grabs.clear();
    for (const id of [...this.props.keys()]) this.removeProp(id, true);
    this.timers.length = 0;
    this.hooks.onClear?.();
  }

  // ---- interactions (authority only) ----
  knockProp(id, d, mag) {
    const p = this.props.get(id);
    if (!this.isAuthority || !p) return;
    const l = Math.hypot(d.x, d.y, d.z) || 1, dv = Math.min(14, mag / p.spec.mass);
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

  startGrab(owner, id) { const p = this.props.get(id); if (this.isAuthority && p) this.grabs.set(owner, { id, target: [p.body.position.x, p.body.position.y, p.body.position.z] }); }
  setGrabTarget(owner, t) { const g = this.grabs.get(owner); if (g) g.target = t; }
  endGrab(owner) { this.grabs.delete(owner); }

  glue(a, b) {
    if (!this.isAuthority || a === b) return false;
    const pa = this.props.get(a), pb = this.props.get(b);
    if (!pa || !pb) return false;
    if (this.glues.some(g => (g.a === a && g.b === b) || (g.a === b && g.b === a))) return false;
    const c = new CANNON.LockConstraint(pa.body, pb.body, { collideConnected: false });
    this.world.addConstraint(c);
    this.glues.push({ a, b, c });
    pa.body.wakeUp(); pb.body.wakeUp();
    return true;
  }
  unglue(id) {
    const keep = [];
    for (const g of this.glues) { if (g.a === id || g.b === id) this.world.removeConstraint(g.c); else keep.push(g); }
    const changed = keep.length !== this.glues.length;
    this.glues = keep;
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
  _preStep() {
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
      if (!p.active || !p.spec.thruster) continue;
      const t = p.spec.thruster;
      V.set(t.dir[0], t.dir[1], t.dir[2]);
      p.body.quaternion.vmult(V, V);
      V.scale(t.thrust, V);
      p.body.wakeUp();
      p.body.applyForce(V);
    }
    for (const g of this.glues) {                          // never let half a glued pair fall asleep
      const a = this.props.get(g.a)?.body, b = this.props.get(g.b)?.body;
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
    if (this.isAuthority) this._preStep();
    this.world.step(1 / 60, dt, 3);
    this._flames();
    if (!this.isAuthority) return;
    for (const t of this.timers) t.t -= dt;
    const due = this.timers.filter(t => t.t <= 0);
    if (due.length) { this.timers = this.timers.filter(t => t.t > 0); for (const t of due) this.detonate(t.id); }
    for (const p of [...this.props.values()]) {
      if (p.body.position.y < -60) { this.removeProp(p.id); continue; }
      p.mesh.position.copy(p.body.position);
      p.mesh.quaternion.copy(p.body.quaternion);
    }
  }

  // ---- network helpers ----
  // props that moved since last call (sleeping ones are sent once, then skipped)
  collectDelta() {
    const out = [];
    for (const p of this.props.values()) {
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
