// effects.js - blast visuals. one permanent point light so shaders never recompile mid-game.
import * as THREE from 'three';

const sphere = new THREE.SphereGeometry(1, 16, 12);
const sparkGeo = new THREE.BoxGeometry(0.12, 0.12, 0.12);

export class Effects {
  constructor(parent) {
    this.parent = parent; this.items = []; this.shake = 0;
    this.flash = new THREE.PointLight(0xffa040, 0, 80, 2);
    parent.add(this.flash);
  }

  explosion(pos, radius) {
    const mk = (color, opacity) => new THREE.Mesh(sphere, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
    const fire = mk(0xff9a2e, 0.95), smoke = mk(0x2a2a2a, 0.6);
    fire.position.set(pos.x, pos.y, pos.z); smoke.position.copy(fire.position);
    const sparks = [];
    for (let i = 0; i < 16; i++) {
      const m = new THREE.Mesh(sparkGeo, new THREE.MeshBasicMaterial({ color: 0xffd070 }));
      m.position.copy(fire.position);
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 1.2 + 0.3, Math.random() - 0.5).normalize().multiplyScalar(radius * (0.8 + Math.random() * 1.2));
      sparks.push({ m, v });
      this.parent.add(m);
    }
    this.parent.add(fire, smoke);
    this.flash.position.copy(fire.position);
    this.items.push({ t: 0, dur: 1.1, radius, fire, smoke, sparks });
  }

  update(dt) {
    this.shake = Math.max(0, this.shake - dt * 1.5);
    let flash = 0;
    for (const it of [...this.items]) {
      it.t += dt;
      const k = it.t / it.dur;
      if (k >= 1) {
        for (const o of [it.fire, it.smoke, ...it.sparks.map(s => s.m)]) { this.parent.remove(o); o.material.dispose(); }
        this.items.splice(this.items.indexOf(it), 1);
        continue;
      }
      const grow = 1 - Math.pow(1 - Math.min(k * 2.2, 1), 2);
      it.fire.scale.setScalar(it.radius * 0.55 * grow + 0.1);
      it.fire.material.opacity = Math.max(0, 0.95 * (1 - k * 1.6));
      it.smoke.scale.setScalar(it.radius * 0.75 * Math.min(k * 1.5, 1) + 0.1);
      it.smoke.material.opacity = 0.55 * (1 - k);
      for (const s of it.sparks) { s.v.y -= 20 * dt; s.m.position.addScaledVector(s.v, dt); }
      flash = Math.max(flash, it.radius * it.radius * 0.9 * Math.max(0, 1 - k * 3));
    }
    this.flash.intensity = flash;
  }
}
