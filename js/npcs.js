// npcs.js - npcs (same model + animations as the player) and nextbot ai. authority (host / singleplayer) only.
import * as CANNON from 'cannon-es';
import { PLAYER, NPC, NEXTBOT, GROUPS } from './config.js';
import { Avatar } from './player.js';
import { lerpAngle } from './interp.js';
import { SPAWNABLES } from './spawnables.js';

const r3 = v => Math.round(v * 1000) / 1000;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class Npcs {
  constructor(group, physics) { this.group = group; this.physics = physics; this.list = new Map(); this.nextId = 1; }

  spawn(pos, yaw = 0) {
    if (this.list.size >= NPC.MAX) return null;
    const id = this.nextId++;
    const body = this.physics.createPlayerBody();
    body.position.set(pos[0], pos[1], pos[2]);
    const av = new Avatar('npc');
    this.group.add(av.group);
    const n = { id, body, av, hp: NPC.HP, yaw, state: 'idle', mode: 'idle', timer: 1 + Math.random() * 2, goal: null,
      stun: 0, fleeT: 0, fleeFrom: null, item: null, itemProp: null, scanT: 0.5, deadT: 0, stuckT: 0, grounded: false, airT: 0, t: Math.random() * 10 };
    this.list.set(id, n);
    this._pose(n, 0);
    return n;
  }

  remove(id) {
    const n = this.list.get(id);
    if (!n) return;
    this.physics.removeBody(n.body);
    n.av.dispose();
    this.list.delete(id);
  }
  clear() { for (const id of [...this.list.keys()]) this.remove(id); }

  update(dt, people) { for (const n of [...this.list.values()]) this._tick(n, dt, people); }

  _pose(n, dt) {
    const p = n.body.position;
    n.av.group.position.set(p.x, p.y, p.z);
    n.av.group.rotation.y = n.yaw + PLAYER.MODEL_YAW_OFFSET;
    n.av.setState(n.state);
    n.av.update(dt);
  }

  _tick(n, dt, people) {
    const b = n.body, p = b.position;
    n.t += dt;
    if (p.y < -40) { this.remove(n.id); return; }

    if (n.hp <= 0) {                                     // dead: slide to a stop, lie there, then vanish
      n.deadT -= dt;
      const k = Math.exp(-5 * dt); b.velocity.x *= k; b.velocity.z *= k;
      n.state = 'dead';
      this._pose(n, dt);
      if (n.deadT <= 0) this.remove(n.id);
      return;
    }

    const hit = this.physics.raycast(new CANNON.Vec3(p.x, p.y + 0.2, p.z), new CANNON.Vec3(p.x, p.y - 0.15, p.z));
    n.grounded = !!hit && hit.hitNormalWorld.y > 0.5 && b.velocity.y < 3;
    n.airT = n.grounded ? 0 : n.airT + dt;

    let near = null, nd = 1e9;                           // nearest living person
    for (const q of people) {
      if (q.dead) continue;
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      if (Math.abs(q.y - p.y) < 4 && d < nd) { nd = d; near = q; }
    }

    let dx = 0, dz = 0, speed = 0, face = null;
    const stunned = n.stun > 0;
    if (stunned) n.stun -= dt;
    else if (n.fleeT > 0) {                              // run away from whoever hurt us, with a little weaving
      n.fleeT -= dt;
      const fx = p.x - n.fleeFrom.x, fz = p.z - n.fleeFrom.z, l = Math.hypot(fx, fz) || 1, a = Math.sin(n.t * 2.3) * 0.4;
      dx = (fx / l) * Math.cos(a) - (fz / l) * Math.sin(a);
      dz = (fx / l) * Math.sin(a) + (fz / l) * Math.cos(a);
      speed = NPC.RUN;
    } else {
      n.scanT -= dt;
      if (!n.item && n.itemProp == null && n.scanT <= 0) { n.scanT = 0.6; this._scan(n); }

      if (n.itemProp != null) {                          // walk to an item and pick it up
        const pr = this.physics.props.get(n.itemProp);
        if (!pr) n.itemProp = null;
        else {
          const ix = pr.body.position.x - p.x, iz = pr.body.position.z - p.z, d = Math.hypot(ix, iz) || 1;
          if (d < NPC.ITEM_PICK && Math.abs(pr.body.position.y - p.y) < 1.6) this._take(n, pr);
          else { dx = ix / d; dz = iz / d; speed = NPC.WALK; }
        }
      } else if (near && nd < NPC.LOOK_DIST) {           // someone is close: stop and look at them
        face = Math.atan2(-(near.x - p.x), -(near.z - p.z));
      } else {                                           // wander
        n.timer -= dt;
        if (n.mode === 'idle') {
          if (n.timer <= 0) {
            n.mode = 'walk'; n.timer = 2 + Math.random() * 4;
            const a = Math.random() * Math.PI * 2, r = 4 + Math.random() * 7;
            n.goal = { x: p.x + Math.cos(a) * r, z: p.z + Math.sin(a) * r };
          }
        } else {
          const gx = n.goal.x - p.x, gz = n.goal.z - p.z, d = Math.hypot(gx, gz) || 1;
          if (d < 0.6 || n.timer <= 0) { n.mode = 'idle'; n.timer = 1.5 + Math.random() * 3.5; }
          else { dx = gx / d; dz = gz / d; speed = NPC.WALK; }
        }
      }
    }

    // stuck on something: hop or pick a new direction
    const hs0 = Math.hypot(b.velocity.x, b.velocity.z);
    if (speed > 0 && hs0 < 0.5 && n.grounded) n.stuckT += dt; else n.stuckT = 0;
    if (n.stuckT > 0.5) {
      n.stuckT = 0;
      if (Math.random() < 0.5) b.velocity.y = 6.5;
      else { n.mode = 'idle'; n.timer = 0.2; n.itemProp = null; if (n.fleeFrom) n.fleeFrom = { x: p.x + (Math.random() - 0.5) * 8, z: p.z + (Math.random() - 0.5) * 8 }; }
    }

    if (stunned) {
      if (n.grounded) { const k = Math.exp(-3 * dt); b.velocity.x *= k; b.velocity.z *= k; }
    } else {
      const k = 1 - Math.exp(-(n.grounded ? 12 : 3) * dt);
      b.velocity.x += (dx * speed - b.velocity.x) * k;
      b.velocity.z += (dz * speed - b.velocity.z) * k;
    }

    // smooth turning: exponential ease out, never snaps
    let target = null;
    if (face !== null) target = face; else if (speed > 0.1) target = Math.atan2(-dx, -dz);
    if (target !== null) n.yaw = lerpAngle(n.yaw, target, 1 - Math.exp(-NPC.TURN * dt));

    const hs = Math.hypot(b.velocity.x, b.velocity.z);
    if (stunned) n.state = 'knockback';
    else if (!n.grounded && n.airT > 0.25) n.state = 'fall';
    else if (hs > 0.6) n.state = speed > NPC.WALK + 0.5 ? 'run' : 'walk';
    else n.state = 'idle';
    this._pose(n, dt);
  }

  _scan(n) {                                             // find the nearest visible item lying on the ground
    const p = n.body.position;
    let best = null, bd = NPC.ITEM_SEE;
    for (const pr of this.physics.props.values()) {
      if (!pr.spec.item || pr.spec.op) continue;
      const q = pr.body.position, d = Math.hypot(q.x - p.x, q.z - p.z);
      if (d >= bd || Math.abs(q.y - p.y) > 3) continue;
      if (this.physics.raycast(new CANNON.Vec3(p.x, p.y + 1.5, p.z), new CANNON.Vec3(q.x, q.y + 0.1, q.z), GROUPS.WORLD)) continue;   // wall in the way
      best = pr; bd = d;
    }
    if (best) n.itemProp = best.id;
  }

  _take(n, pr) {
    const item = pr.spec.item;
    this.physics.removeProp(pr.id);
    n.item = item; n.itemProp = null; n.av.holdItem(item);
    n.mode = 'idle'; n.timer = 1.5;
  }

  // dmg from a player/bullet. dir = {x,y,z} direction of the hit, from = attacker position (or null)
  hurt(id, dmg, dir, from) {
    const n = this.list.get(id);
    if (!n || n.hp <= 0) return;
    const p = n.body.position;
    n.hp -= dmg;
    n.stun = Math.max(n.stun, 0.55);
    n.fleeT = 8;
    n.fleeFrom = from ? { x: from.x, z: from.z } : { x: p.x - dir.x * 5, z: p.z - dir.z * 5 };
    n.itemProp = null;
    const l = Math.hypot(dir.x, dir.z) || 1;
    n.body.velocity.x += dir.x / l * 4; n.body.velocity.z += dir.z / l * 4; n.body.velocity.y += 2.5;
    n.grounded = false;
    if (n.hp <= 0) this._die(n);
  }

  _die(n) {
    n.hp = 0; n.deadT = 6;
    n.body.collisionFilterMask = GROUPS.WORLD;
    if (n.item) {                                        // drop what they were holding
      const spec = SPAWNABLES.find(s => s.item === n.item && !s.op);
      const p = n.body.position;
      if (spec) this.physics.spawnProp(spec.id, [p.x, p.y + 1, p.z], 0, { owner: -1 });
      n.item = null; n.av.holdItem(null);
    }
  }

  blast(pos, ex) {
    for (const n of this.list.values()) {
      if (n.hp <= 0) continue;
      const p = n.body.position, dx = p.x - pos.x, dy = p.y + 1 - pos.y, dz = p.z - pos.z, d = Math.hypot(dx, dy, dz);
      if (d > ex.radius) continue;
      const f = 1 - d / ex.radius, ux = dx / (d || 1), uy = dy / (d || 1) + 0.6, uz = dz / (d || 1), l = Math.hypot(ux, uy, uz), v = ex.force * f * 0.9;
      n.body.velocity.x += ux / l * v; n.body.velocity.y += uy / l * v; n.body.velocity.z += uz / l * v;
      n.stun = 0.9; n.fleeT = 8; n.fleeFrom = { x: pos.x, z: pos.z }; n.itemProp = null; n.grounded = false;
      n.hp -= ex.damage * f;
      if (n.hp <= 0) this._die(n);
    }
  }

  snapshot() {
    return [...this.list.values()].map(n => [n.id, r3(n.body.position.x), r3(n.body.position.y), r3(n.body.position.z), r3(n.yaw), n.state, n.item || '']);
  }
}

// ---------------------------------------------------------------- nextbots (props with spec.nextbot)
// chase the nearest person (player or npc), one shot them on contact.
export function updateNextbots(physics, dt, people, npcs, killPerson, killNpc) {
  for (const p of physics.props.values()) {
    if (!p.spec.nextbot) continue;
    const b = p.body;
    b.wakeUp();
    p.killCd = Math.max(0, (p.killCd || 0) - dt);

    let best = null, bd = 1e9;
    for (const q of people) {
      if (q.dead) continue;
      const d = Math.hypot(q.x - b.position.x, q.z - b.position.z);
      if (d < bd) { bd = d; best = { kind: 'player', ref: q, x: q.x, y: q.y, z: q.z }; }
    }
    if (npcs) for (const n of npcs.list.values()) {
      if (n.hp <= 0) continue;
      const q = n.body.position, d = Math.hypot(q.x - b.position.x, q.z - b.position.z);
      if (d < bd) { bd = d; best = { kind: 'npc', ref: n, x: q.x, y: q.y, z: q.z }; }
    }
    if (!best) { const k = Math.exp(-4 * dt); b.velocity.x *= k; b.velocity.z *= k; continue; }

    const speed = clamp(Number(p.data?.speed) || NEXTBOT.SPEED_DEFAULT, NEXTBOT.SPEED_MIN, NEXTBOT.SPEED_MAX);
    const dx = best.x - b.position.x, dz = best.z - b.position.z, l = Math.hypot(dx, dz) || 1, k = 1 - Math.exp(-10 * dt);
    b.velocity.x += (dx / l * speed - b.velocity.x) * k;
    b.velocity.z += (dz / l * speed - b.velocity.z) * k;

    const hs = Math.hypot(b.velocity.x, b.velocity.z);       // blocked by something? hop
    p.stuckT = (hs < speed * 0.3 && bd > 2) ? (p.stuckT || 0) + dt : 0;
    if (p.stuckT > 0.4) {
      p.stuckT = 0;
      const g = physics.raycast(new CANNON.Vec3(b.position.x, b.position.y, b.position.z), new CANNON.Vec3(b.position.x, b.position.y - 0.85, b.position.z), GROUPS.WORLD);
      if (g) b.velocity.y = 7.5;
    }

    if (bd < NEXTBOT.CATCH && Math.abs(best.y - b.position.y) < 2 && p.killCd <= 0) {
      p.killCd = 1;
      if (best.kind === 'player') killPerson(best.ref); else killNpc(best.ref, b.position);
    }
  }
}
