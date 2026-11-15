// player.js - local first-person controller + the animated avatar used for remote players.
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { KEYS, keyHeld, PLAYER, ANIMS, ONE_SHOT, PLAYER_MODEL } from './config.js';
import { cloneModel, makePlaceholder, makeLabel } from './assets.js';
import * as audio from './audio.js';

// ---------------------------------------------------------------- avatar
export class Avatar {
  constructor(name) {
    this.group = new THREE.Group();     // origin = feet
    this.state = '';
    this.cur = null;
    this.mixer = null;
    this.actions = Object.create(null);
    const inst = cloneModel(PLAYER_MODEL);
    if (inst) this._init(inst);
    else {
      const ph = makePlaceholder({ shape: 'box', size: [0.3, 0.9, 0.2], color: 0x3b82f6 });
      ph.position.y = 0.9;
      this.group.add(ph);
    }
    this.setName(name);
    this.setState('idle');
  }

  _init(inst) {
    const model = inst.object, holder = new THREE.Group();
    holder.add(model);
    holder.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(holder);
    model.scale.setScalar(PLAYER.HEIGHT / ((box.max.y - box.min.y) || 1));   // fit to player height
    holder.updateMatrixWorld(true);
    box.setFromObject(holder);
    model.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);   // feet on origin
    model.traverse(o => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
    this.group.add(holder);

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
    this.tag.position.y = PLAYER.HEIGHT + 0.4;
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

  update(dt) { this.mixer?.update(dt); }
  dispose() { this.mixer?.stopAllAction(); this.group.parent?.remove(this.group); }
}

// ---------------------------------------------------------------- local player
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
    this.onRespawn = null;
  }

  spawn(pt) {
    const b = this.body;
    b.position.set(pt[0], pt[1], pt[2]); b.velocity.set(0, 0, 0);
    this.hp = PLAYER.MAX_HP; this.dead = false; this.knockback = false; this.fallSpeed = 0; this.airTime = 0;
  }

  look(dx, dy, sens) {
    this.yaw -= dx * sens;
    this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch - dy * sens));
  }

  damage(n) {
    if (this.dead || n <= 0) return;
    this.hp = Math.max(0, this.hp - n);
    if (this.hp <= 0) this._die();
  }
  _die() { this.dead = true; this.deathTimer = PLAYER.RESPAWN_DELAY; this.knockback = false; }

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
    this.knockback = true; this.knockTime = 0; this.grounded = false; this.airFromJump = false;
    this.damage(ex.damage * f);
  }

  _land() {
    const v = this.fallSpeed; this.fallSpeed = 0;
    if (v > 4) audio.play('land', { volume: Math.min(1, v / 14) });
    if (v > PLAYER.FALL_SAFE && !this.dead) this.damage((v - PLAYER.FALL_SAFE) * PLAYER.FALL_DMG);
  }

  update(dt, keys, enabled) {
    const b = this.body, p = b.position;
    const down = a => enabled && !this.dead && keyHeld(keys, a);

    // ground probe from just above the feet to just below them
    const hit = this.physics.raycast(new CANNON.Vec3(p.x, p.y + 0.2, p.z), new CANNON.Vec3(p.x, p.y - 0.15, p.z));
    const was = this.grounded;
    this.grounded = !!hit && hit.hitNormalWorld.y > 0.5 && b.velocity.y < 3;
    if (hit) this.surface = hit.body?.surface || 'concrete';
    if (!this.grounded) { this.fallSpeed = Math.max(this.fallSpeed, -b.velocity.y); this.airTime += dt; }
    else { if (!was) this._land(); this.airTime = 0; this.airFromJump = false; }

    if (this.knockback) { this.knockTime += dt; if (this.grounded && this.knockTime > 0.3) this.knockback = false; }
    if (this.dead) { this.deathTimer -= dt; if (this.deathTimer <= 0) this.onRespawn?.(); }
    if (p.y < -40 && !this.dead) { this.hp = 0; this._die(); }

    // input -> desired velocity
    const f = (down('forward') ? 1 : 0) - (down('back') ? 1 : 0);
    const s = (down('right') ? 1 : 0) - (down('left') ? 1 : 0);
    // sprint only while moving FORWARD (w, or w + a/d). sideways-only or backwards never sprints.
    const sprint = down('sprint') && down('forward') && !down('back');
    let speed = sprint ? PLAYER.SPRINT : PLAYER.WALK;
    if (f < 0) speed *= PLAYER.BACK_MULT;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    let dx = -sin * f + cos * s, dz = -cos * f - sin * s;
    const len = Math.hypot(dx, dz);
    if (len > 0) { dx /= len; dz /= len; }

    if (this.dead) {
      const k = Math.exp(-6 * dt); b.velocity.x *= k; b.velocity.z *= k;
    } else if (this.knockback) {
      if (this.grounded) { const k = Math.exp(-3 * dt); b.velocity.x *= k; b.velocity.z *= k; }   // slide to a stop
    } else {
      const k = 1 - Math.exp(-(this.grounded ? 14 : 3) * dt);     // snappy on ground, floaty in the air
      b.velocity.x += (dx * speed - b.velocity.x) * k;
      b.velocity.z += (dz * speed - b.velocity.z) * k;
    }

    if (down('jump') && this.grounded && !this.knockback) {
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

    // footsteps
    if (this.grounded && !this.dead && hs > 1) {
      this.stepTimer -= dt * (hs / PLAYER.WALK);
      if (this.stepTimer <= 0) { this.stepTimer = 0.5; audio.play('footstep_' + this.surface, { volume: 0.6, rate: 0.92 + Math.random() * 0.16 }); }
    }
  }

  // call after the physics step so the camera never lags a frame behind the body
  placeCamera(dt) {
    const k = 1 - Math.exp(-6 * dt);
    this.eye += ((this.dead ? 0.4 : PLAYER.EYE) - this.eye) * k;
    this.roll += ((this.dead ? 0.9 : 0) - this.roll) * k;
    const p = this.body.position;
    this.camera.position.set(p.x, p.y + this.eye, p.z);
    this.camera.rotation.set(this.pitch, this.yaw, this.roll);
  }

  netState() { const p = this.body.position; return { p: [p.x, p.y, p.z], yaw: this.yaw, pitch: this.pitch, an: this.state }; }
}
