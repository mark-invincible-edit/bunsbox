// player.js - local first-person controller + the animated avatar used for remote players and npcs.
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { keyHeld, PLAYER, ANIMS, ONE_SHOT, PLAYER_MODEL, GROUPS } from './config.js';
import { cloneModel, makePlaceholder, makeLabel } from './assets.js';
import { ITEMS, buildItemModel } from './items.js';
import * as audio from './audio.js';

// ---------------------------------------------------------------- avatar
export class Avatar {
  constructor(name) {
    this.group = new THREE.Group();     // origin = feet
    this.holder = new THREE.Group();    // everything visible except the name tag (so we can sink it when dead/sitting)
    this.group.add(this.holder);
    this.state = ''; this.cur = null; this.mixer = null; this.actions = Object.create(null);
    this.hand = null; this.held = null; this.heldId = null; this.yOff = 0;
    const inst = cloneModel(PLAYER_MODEL);
    if (inst) this._init(inst);
    else {
      const ph = makePlaceholder({ shape: 'box', size: [0.3, 0.9, 0.2], color: 0x3b82f6 });
      ph.position.y = 0.9;
      this.holder.add(ph);
    }
    this.setName(name);
    this.setState('idle');
  }

  _init(inst) {
    const model = inst.object, fit = new THREE.Group();
    fit.add(model);
    fit.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(fit);
    model.scale.setScalar(PLAYER.HEIGHT / ((box.max.y - box.min.y) || 1));   // fit to player height
    fit.updateMatrixWorld(true);
    box.setFromObject(fit);
    model.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);   // feet on origin
    model.traverse(o => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
    this.holder.add(fit);

    // right hand bone for held items (mixamo name first, then any bone that looks like a right hand)
    let hand = model.getObjectByName('mixamorigRightHand');
    if (!hand) model.traverse(o => { if (!hand && o.isBone && /right.?hand$/i.test(o.name)) hand = o; });
    this.hand = hand || null;
    if (!hand) console.warn('[anim] no right hand bone found, held items float next to the body');

    this.mixer = new THREE.AnimationMixer(model);
    const find = n => THREE.AnimationClip.findByName(inst.clips, n) || inst.clips.find(c => c.name.trim().toLowerCase() === n.toLowerCase());
    const idleClip = find(ANIMS.idle);
    for (const [state, clipName] of Object.entries(ANIMS)) {
      let clip = find(clipName);
      if (!clip) { console.warn(`[anim] clip "${clipName}" not found for state "${state}", using idle`); clip = idleClip; }
      if (!clip) continue;
      const a = this.mixer.clipAction(clip);
      if (ONE_SHOT.includes(state)) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
      this.actions[state] = a;
    }
  }

  setName(name) {
    if (this.tag) { this.group.remove(this.tag); this.tag.material.map.dispose(); this.tag.material.dispose(); }
    this.tag = makeLabel(name || 'player');
    this.group.add(this.tag);
  }

  setState(next) {
    if (next === this.state) return;
    this.state = next;
    const a = this.actions[next] || this.actions.idle;
    if (!a || a === this.cur) return;
    const fade = next === 'dead' ? 0.1 : 0.2;
    a.reset().fadeIn(fade).play();
    if (this.cur) this.cur.fadeOut(fade);
    this.cur = a;
  }

  // put an item in the hand bone (or float it next to the body if the rig has no hand bone)
  holdItem(id) {
    id = id && ITEMS[id] ? id : null;
    if (id === this.heldId) return;
    if (this.held) this.held.parent?.remove(this.held);
    this.held = null; this.heldId = id;
    if (!id) return;
    const def = ITEMS[id], m = buildItemModel(id), parent = this.hand || this.group;
    m.traverse(o => { if (o.isMesh) o.frustumCulled = false; });
    if (this.hand) {
      parent.updateWorldMatrix(true, false);
      const ws = new THREE.Vector3(); parent.getWorldScale(ws);
      const k = 1 / (ws.x || 1);                       // cancel the bone's inherited scale so the item keeps real-world size
      m.scale.setScalar(k);
      m.position.set(...def.hand.pos).multiplyScalar(k);
    } else m.position.set(0.3, 1.0, 0.2);
    m.rotation.set(...def.hand.rot);
    parent.add(m);
    this.held = m;
  }
  itemTip(out) { const t = this.held?.userData.tip; return t ? t.getWorldPosition(out) : null; }

  update(dt) {
    this.mixer?.update(dt);
    // dead = sink into the ground, sitting = drop onto the seat
    const target = this.state === 'dead' ? PLAYER.DEAD_Y_OFFSET : this.state === 'sit' ? -PLAYER.SIT_DROP : 0;
    this.yOff += (target - this.yOff) * (1 - Math.exp(-8 * dt));
    this.holder.position.y = this.yOff;
    this.tag.position.y = PLAYER.HEIGHT + 0.4 + Math.min(0, this.yOff);
  }
  dispose() { this.mixer?.stopAllAction(); this.group.parent?.remove(this.group); }
}

// ---------------------------------------------------------------- local player
const _v = new THREE.Vector3(), _e = new THREE.Euler();
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
const AXIS_Y = new THREE.Vector3(0, 1, 0), AXIS_X = new THREE.Vector3(1, 0, 0);

export class LocalPlayer {
  constructor(physics, camera) {
    this.physics = physics; this.camera = camera;
    this.body = physics.createPlayerBody();
    this.yaw = 0; this.pitch = 0;
    this.hp = PLAYER.MAX_HP; this.dead = false; this.deathTimer = 0;
    this.grounded = false; this.airTime = 0; this.airFromJump = false; this.fallSpeed = 0;
    this.knockback = false; this.knockTime = 0;
    this.state = 'idle'; this.surface = 'concrete'; this.stepTimer = 0;
    this.eye = PLAYER.EYE; this.roll = 0;
    this.seat = null;                   // {prop, t, lastYaw} while sitting
    this.tilt = new THREE.Quaternion(); // chair rotation without its heading: makes you tip over with the chair
    this.bhop = 0; this.sinceLand = 1;
    this.onRespawn = null; this.onHurt = null; this.onDeath = null;
  }

  spawn(pt) {
    const b = this.body;
    this.unseat(true);
    b.position.set(pt[0], pt[1], pt[2]); b.velocity.set(0, 0, 0);
    this.hp = PLAYER.MAX_HP; this.dead = false; this.knockback = false; this.fallSpeed = 0; this.airTime = 0; this.bhop = 0;
  }

  look(dx, dy, sens) {
    this.yaw -= dx * sens;
    this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch - dy * sens));
  }

  damage(n) {
    if (this.dead || n <= 0) return;
    this.onHurt?.(n);
    this.hp = Math.max(0, this.hp - n);
    if (this.hp <= 0) this._die();
  }
  _die() { this.dead = true; this.deathTimer = PLAYER.RESPAWN_DELAY; this.knockback = false; this.bhop = 0; this.onDeath?.(); }

  // melee/bullets: damage + a little shove. dir = [x,y,z]
  hurt(dmg, dir) {
    if (this.dead) return;
    this.damage(dmg);
    if (!this.dead && dir) {
      const l = Math.hypot(dir[0], dir[1], dir[2]) || 1;
      this.body.velocity.x += dir[0] / l * 4; this.body.velocity.z += dir[2] / l * 4; this.body.velocity.y += 2.5;
      this.grounded = false;
    }
  }

  // called by main for every explosion (host and clients alike)
  applyBlast(o, ex) {
    if (this.dead) return;
    const b = this.body, p = b.position;
    const dx = p.x - o.x, dy = (p.y + 1) - o.y, dz = p.z - o.z, d = Math.hypot(dx, dy, dz);
    if (d > ex.radius) return;
    const f = 1 - d / ex.radius;
    const ux = dx / (d || 1), uy = dy / (d || 1) + 0.6, uz = dz / (d || 1), l = Math.hypot(ux, uy, uz);
    const v = ex.force * f * 0.9;
    b.velocity.x += ux / l * v; b.velocity.y += uy / l * v; b.velocity.z += uz / l * v;
    this.unseat(true);
    this.knockback = true; this.knockTime = 0; this.grounded = false; this.airFromJump = false;
    this.damage(ex.damage * f);
  }

  // ---- chairs (works even if the chair is tipped over, you just tip with it) ----
  sit(prop) {
    this.seat = { prop, t: 0, lastYaw: null };
    this.body.collisionFilterMask = GROUPS.WORLD;                                // ignore the chair itself while seated
    this.knockback = false; this.bhop = 0;
    return true;
  }
  unseat(silent = false) {
    if (!this.seat) return;
    this.seat = null;
    this.tilt.identity();
    const b = this.body;
    b.collisionFilterMask = GROUPS.WORLD | GROUPS.PROP;
    if (!silent) { b.position.x -= Math.sin(this.yaw) * 0.75; b.position.z -= Math.cos(this.yaw) * 0.75; b.position.y += 0.1; }
    b.velocity.set(0, 0, 0);
  }

  _land() {
    const v = this.fallSpeed; this.fallSpeed = 0;
    if (v > 4) audio.play('land', { volume: Math.min(1, v / 14) });
    if (v > PLAYER.FALL_SAFE && !this.dead) this.damage((v - PLAYER.FALL_SAFE) * PLAYER.FALL_DMG);
  }

  update(dt, keys, enabled) {
    const b = this.body, p = b.position;
    const down = a => enabled && !this.dead && keyHeld(keys, a);

    if (this.seat) {                                    // glued to the chair
      const pr = this.seat.prop;
      if (this.dead || !this.physics.props.has(pr.id)) this.unseat();
      else {
        this.seat.t += dt;
        const m = pr.mesh;
        _e.setFromQuaternion(m.quaternion, 'YXZ');                      // chair heading
        const cy = _e.y;
        _qa.setFromAxisAngle(AXIS_Y, cy).invert();
        this.tilt.copy(m.quaternion).multiply(_qa);                    // tilt = chair rotation minus heading
        if (this.seat.lastYaw !== null) { let d = cy - this.seat.lastYaw; d = Math.atan2(Math.sin(d), Math.cos(d)); this.yaw += d; }   // view spins with the chair
        this.seat.lastYaw = cy;
        _v.set(0, -pr.spec.size[1], 0).applyQuaternion(m.quaternion).add(m.position);   // feet at the chair's floor
        b.position.set(_v.x, _v.y, _v.z); b.velocity.set(0, 0, 0);
        this.grounded = true; this.airTime = 0; this.fallSpeed = 0; this.knockback = false;
        if (down('jump') && this.seat.t > 0.3) this.unseat();
        else { this.state = 'sit'; return; }
      }
    }

    // ground probe from just above the feet to just below them
    const hit = this.physics.raycast(new CANNON.Vec3(p.x, p.y + 0.2, p.z), new CANNON.Vec3(p.x, p.y - 0.15, p.z));
    const was = this.grounded;
    this.grounded = !!hit && hit.hitNormalWorld.y > 0.5 && b.velocity.y < 3;
    if (hit) this.surface = hit.body?.surface || 'concrete';
    if (!this.grounded) { this.fallSpeed = Math.max(this.fallSpeed, -b.velocity.y); this.airTime += dt; this.sinceLand = 0; }
    else { if (!was) this._land(); this.airTime = 0; this.airFromJump = false; this.sinceLand += dt; }

    if (this.knockback) { this.knockTime += dt; if (this.grounded && this.knockTime > 0.3) this.knockback = false; }
    if (this.dead) { this.deathTimer -= dt; if (this.deathTimer <= 0) this.onRespawn?.(); }
    if (p.y < -40 && !this.dead) { this.hp = 0; this._die(); }

    const f = (down('forward') ? 1 : 0) - (down('back') ? 1 : 0);
    const s = (down('right') ? 1 : 0) - (down('left') ? 1 : 0);
    const moving = f !== 0 || s !== 0;
    // sprint only while moving FORWARD (w, or w + a/d). sideways-only or backwards never sprints.
    const sprint = down('sprint') && down('forward') && !down('back');
    let speed = sprint ? PLAYER.SPRINT : PLAYER.WALK;
    if (f < 0) speed *= PLAYER.BACK_MULT;

    // bhop bonus bleeds off when you stop hopping or stop moving
    if (this.grounded && (this.sinceLand > 0.2 || !moving)) this.bhop = Math.max(0, this.bhop - PLAYER.BHOP_DECAY * dt);
    speed *= 1 + this.bhop;

    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    let dx = -sin * f + cos * s, dz = -cos * f - sin * s;
    const len = Math.hypot(dx, dz);
    if (len > 0) { dx /= len; dz /= len; }

    if (this.dead) {
      const k = Math.exp(-6 * dt); b.velocity.x *= k; b.velocity.z *= k;
    } else if (this.knockback) {
      if (this.grounded) { const k = Math.exp(-3 * dt); b.velocity.x *= k; b.velocity.z *= k; }
    } else {
      const k = 1 - Math.exp(-(this.grounded ? 14 : 3) * dt);     // snappy on ground, floaty in the air
      b.velocity.x += (dx * speed - b.velocity.x) * k;
      b.velocity.z += (dz * speed - b.velocity.z) * k;
    }

    if (down('jump') && this.grounded && !this.knockback) {
      if (moving && this.sinceLand < 0.15) this.bhop = Math.min(PLAYER.BHOP_MAX, this.bhop + PLAYER.BHOP_GAIN);   // landed and jumped right away = chain
      b.velocity.y = PLAYER.JUMP; this.grounded = false; this.airFromJump = true; this.airTime = 0;
      audio.play('jump');
    }

    // animation state machine
    const hs = Math.hypot(b.velocity.x, b.velocity.z);
    let st;
    if (this.dead) st = 'dead';
    else if (this.knockback) st = 'knockback';
    else if (!this.grounded) st = (this.airFromJump && this.airTime < 0.65) ? 'jump' : (this.airTime > 0.18 ? 'fall' : this.state);
    else if (hs < 0.6 || (f === 0 && s === 0)) st = 'idle';
    else if (f < 0) st = 'back';
    else if (f > 0) st = sprint ? 'run' : 'walk';
    else st = s < 0 ? 'left' : 'right';
    this.state = st;

    if (this.grounded && !this.dead && hs > 1) {
      this.stepTimer -= dt * (hs / PLAYER.WALK);
      if (this.stepTimer <= 0) { this.stepTimer = 0.5; audio.play('footstep_' + this.surface, { volume: 0.6, rate: 0.92 + Math.random() * 0.16 }); }
    }
  }

  // call after the physics step so the camera never lags a frame behind the body
  placeCamera(dt) {
    const k = 1 - Math.exp(-6 * dt);
    const eye = this.dead ? 0.4 : this.seat ? PLAYER.EYE - PLAYER.SIT_DROP : PLAYER.EYE;
    this.eye += (eye - this.eye) * k;
    this.roll += ((this.dead ? 0.9 : 0) - this.roll) * k;
    const p = this.body.position;
    if (this.seat) {                                    // camera rides along with the (possibly tipped) chair
      _v.set(0, this.eye, 0).applyQuaternion(this.tilt);
      this.camera.position.set(p.x + _v.x, p.y + _v.y, p.z + _v.z);
      _qa.setFromAxisAngle(AXIS_Y, this.yaw); _qb.setFromAxisAngle(AXIS_X, this.pitch);
      this.camera.quaternion.copy(this.tilt).multiply(_qa).multiply(_qb);
    } else {
      this.camera.position.set(p.x, p.y + this.eye, p.z);
      this.camera.rotation.set(this.pitch, this.yaw, this.roll);
    }
  }

  netState() {
    const p = this.body.position, t = this.tilt;
    return { p: [p.x, p.y, p.z], yaw: this.yaw, pitch: this.pitch, an: this.state,
      tq: this.seat ? [Math.round(t.x * 1000) / 1000, Math.round(t.y * 1000) / 1000, Math.round(t.z * 1000) / 1000, Math.round(t.w * 1000) / 1000] : null };
  }
}
