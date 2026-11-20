// vehicles.js - procedural vehicle models (so vehicles work with no assets at all) + wheel animation.
// forward is -z (same as the player). a glb can replace the procedural model, see the vehicle notes in spawnables.js.
import * as THREE from 'three';

const D2R = Math.PI / 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const TIRE = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.9 });
const HUB = new THREE.MeshStandardMaterial({ color: 0xb9bec6, roughness: 0.4, metalness: 0.6 });
const DARK = new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.7, metalness: 0.3 });
const GLASS = new THREE.MeshStandardMaterial({ color: 0x9fd8ff, roughness: 0.1, metalness: 0, transparent: true, opacity: 0.45 });
const LAMP_F = new THREE.MeshBasicMaterial({ color: 0xfff2b0 });
const LAMP_R = new THREE.MeshBasicMaterial({ color: 0xff2a2a });

const part = (g, w, h, d, mat, x, y, z, rx = 0) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z); m.rotation.x = rx;
  m.castShadow = true; m.receiveShadow = true;
  g.add(m);
  return m;
};

function makeWheel(g, vc, [x, y, z, front]) {
  const r = vc.wheelR, w = vc.wheelW;
  const pivot = new THREE.Group();            // steers (yaw)
  pivot.position.set(x, y, z);
  const spin = new THREE.Group();             // rolls (around the axle, x)
  const tire = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 20), TIRE);
  tire.rotation.z = Math.PI / 2;
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.55, r * 0.55, w * 1.04, 14), HUB);
  hub.rotation.z = Math.PI / 2;
  const bar = new THREE.Mesh(new THREE.BoxGeometry(w * 1.1, r * 0.22, r * 1.1), DARK);   // so you can see it spin
  tire.castShadow = true;
  spin.add(tire, hub, bar);
  pivot.add(spin);
  g.add(pivot);
  return { pivot, spin, front: !!front };
}

// a glb is scaled so its length matches the collider, turned by modelYaw, and set on the ground line
function fitModel(g, model, spec) {
  const vc = spec.vehicle, pre = new THREE.Group();
  pre.add(model);
  pre.rotation.y = (spec.modelYaw ?? 180) * D2R;
  g.add(pre);
  g.updateMatrixWorld(true);
  const size = new THREE.Box3().setFromObject(g).getSize(new THREE.Vector3());
  pre.scale.setScalar((spec.size[2] * 2) / (size.z || 1));
  g.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(g), c = box.getCenter(new THREE.Vector3());
  pre.position.set(-c.x, vc.ground - box.min.y, -c.z);
  model.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
}

export function buildVehicleVisual(spec, model = null) {
  const vc = spec.vehicle, [hx, hy, hz] = spec.size, g = new THREE.Group();
  const info = { wheels: [], last: new THREE.Vector3(), lastYaw: 0, init: false, steer: 0, spin: 0, speed: 0, radius: vc.wheelR, base: 2.4 };
  g.userData.veh = info;
  if (model) { fitModel(g, model, spec); return g; }

  const paint = new THREE.MeshStandardMaterial({ color: vc.color, roughness: 0.4, metalness: 0.35 });
  const W = hx * 2, L = hz * 2;
  if (vc.kind === 'truck') {
    part(g, W, 0.4, L, DARK, 0, -0.2, 0);                                  // frame
    part(g, W, 0.8, 1.2, paint, 0, 0.0, -hz + 0.6);                        // hood
    for (const s of [-1, 1]) part(g, 0.14, 0.7, 1.3, paint, s * (hx - 0.07), -0.05, -0.65);   // cab sides
    part(g, W * 0.82, 0.6, 0.14, DARK, 0, 0.1, 0.1);                       // seat back
    part(g, W * 0.9, 0.55, 0.06, GLASS, 0, 0.55, -1.2, 0.4);              // windshield
    part(g, W, 0.15, 2.0, DARK, 0, -0.33, 1.4);                            // bed floor
    for (const s of [-1, 1]) part(g, 0.1, 0.6, 2.0, paint, s * (hx - 0.05), -0.02, 1.4);
    part(g, W, 0.6, 0.1, paint, 0, -0.02, 0.4);
    part(g, W, 0.6, 0.1, paint, 0, -0.02, hz - 0.05);
    for (const s of [-1, 1]) { part(g, 0.35, 0.16, 0.06, LAMP_F, s * (hx - 0.3), 0.05, -hz); part(g, 0.3, 0.14, 0.06, LAMP_R, s * (hx - 0.25), -0.05, hz); }
  } else if (vc.kind === 'kart') {
    part(g, W, 0.2, L, paint, 0, -0.1, 0);
    part(g, 0.7, 0.22, 0.5, paint, 0, 0.0, -0.6);                          // nose
    part(g, W * 0.9, 0.5, 0.1, DARK, 0, 0.2, 0.62);                        // seat back
    part(g, 0.3, 0.04, 0.04, DARK, 0, 0.26, -0.3);                         // steering wheel
    for (const s of [-1, 1]) { part(g, 0.14, 0.12, 0.06, LAMP_F, s * 0.25, 0.04, -hz); part(g, 0.12, 0.1, 0.06, LAMP_R, s * 0.35, 0.0, hz); }
  } else {   // car (open top roadster)
    part(g, W, 0.4, L, DARK, 0, -0.15, 0);                                  // floor pan
    part(g, W, 0.65, 1.3, paint, 0, -0.025, -hz + 0.65);                    // hood
    part(g, W, 0.65, 1.0, paint, 0, -0.025, hz - 0.5);                      // trunk
    for (const s of [-1, 1]) part(g, 0.14, 0.55, 1.5, paint, s * (hx - 0.07), 0.0, 0.15);   // doors
    part(g, W * 0.7, 0.55, 0.14, DARK, 0, 0.25, 0.75);                      // seat back
    part(g, W * 0.82, 0.5, 0.05, GLASS, 0, 0.5, -0.65, 0.45);               // windshield
    for (const s of [-1, 1]) { part(g, 0.3, 0.14, 0.05, LAMP_F, s * (hx - 0.3), 0.1, -hz); part(g, 0.3, 0.12, 0.05, LAMP_R, s * (hx - 0.3), 0.1, hz); }
  }
  const zs = vc.wheels.map(w => w[2]);
  info.base = (Math.max(...zs) - Math.min(...zs)) || 2.4;
  for (const w of vc.wheels) info.wheels.push(makeWheel(g, vc, w));
  return g;
}

// spin + steer the wheels from how the body actually moved (works for the host and for clients alike)
const _f = new THREE.Vector3(), _e = new THREE.Euler();
export function animateVehicle(prop, dt) {
  const v = prop.mesh.userData.veh;
  if (!v || !(dt > 0)) return;
  const m = prop.mesh, yaw = _e.setFromQuaternion(m.quaternion, 'YXZ').y;
  if (!v.init) { v.last.copy(m.position); v.lastYaw = yaw; v.init = true; return; }
  _f.set(0, 0, -1).applyQuaternion(m.quaternion);
  const vf = ((m.position.x - v.last.x) * _f.x + (m.position.z - v.last.z) * _f.z) / dt;
  let dy = yaw - v.lastYaw;
  dy = Math.atan2(Math.sin(dy), Math.cos(dy));
  const target = Math.abs(vf) > 1.5 ? clamp(Math.atan(v.base * (dy / dt) / vf), -0.5, 0.5) : 0;
  v.steer += (target - v.steer) * (1 - Math.exp(-10 * dt));
  v.spin -= vf * dt / v.radius;
  v.speed += (Math.abs(vf) - v.speed) * (1 - Math.exp(-8 * dt));
  for (const w of v.wheels) { w.spin.rotation.x = v.spin; w.pivot.rotation.y = w.front ? v.steer : 0; }
  v.last.copy(m.position); v.lastYaw = yaw;
}
