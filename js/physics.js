// physics.js - cannon-es world. the host / singleplayer simulates props; clients only mirror them
// (kinematic bodies driven by snapshots) so the client player can still stand on / bump into them.
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { PLAYER, GROUPS, LIMITS } from './config.js';
import { getSpawnable } from './spawnables.js';
import { cloneModel, makePlaceholder } from './assets.js';
import { SnapshotBuffer } from './interp.js';

const r3 = v => Math.round(v * 1000) / 1000;

export class Physics {
  constructor(group, isAuthority) {
    this.group = group;
    this.isAuthority = isAuthority;
    this.hooks = {};            // onSpawn(prop) onRemove(id) onClear() onExplosion(pos, ex)
    this.props = new Map();
    this.remote = new Map();    // host only: kinematic bodies for remote players so they can push props
    this.timers = [];           // {t, id} fuses + chain reactions
    this.nextId = 1;

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
    const inst = spec.glb ? cloneModel(spec.glb) : null;
    if (inst) {
      const o = inst.object;
      o.scale.multiplyScalar(spec.scale ?? 1);
      holder.add(o);
      holder.updateMatrixWorld(true);
      const c = new THREE.Box3().setFromObject(holder).getCenter(new THREE.Vector3());
      o.position.sub(c);                      // center the model on the physics body
      o.traverse(m => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
    } else {
      holder.add(makePlaceholder({ shape: spec.shape, size: spec.size, color: spec.color, label: spec.name }));
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

    const prop = { id, key, spec, body, mesh, owner: opts.owner ?? 0, buf: new SnapshotBuffer(), sentSleep: false, chained: false };
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
    this.world.removeBody(p.body);
    this.group.remove(p.mesh);
    this.props.delete(id);
    if (!silent) this.hooks.onRemove?.(id);
    return true;
  }
  clearProps() {
    for (const id of [...this.props.keys()]) this.removeProp(id, true);
    this.timers.length = 0;
    this.hooks.onClear?.();
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
  step(dt) {
    this.world.step(1 / 60, dt, 3);
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
