// preview.js - renders every spawnable once on a grey background for the spawn menu.
import * as THREE from 'three';
import { SPAWNABLES } from './spawnables.js';
import { buildVisual } from './physics.js';
import { Avatar } from './player.js';

// returns Map(spawnable id -> png data url). empty map if webgl fails (menu falls back to colored squares).
export function generatePreviews(size = 128) {
  const out = new Map();
  let r;
  try { r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }); } catch (e) { return out; }
  r.setPixelRatio(1);
  r.setSize(size, size, false);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x6e737b);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x555a62, 1.5));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(3, 5, 4);
  scene.add(sun);
  const cam = new THREE.PerspectiveCamera(35, 1, 0.01, 200);

  for (const spec of SPAWNABLES) {
    try {
      let obj;
      if (spec.npc) {                                          // npc = the player model in its idle pose
        const av = new Avatar('');
        av.group.remove(av.tag);
        av.update(0.3);
        obj = av.group;
      } else obj = buildVisual(spec, null);
      scene.add(obj);
      obj.updateMatrixWorld(true);
      const sphere = new THREE.Box3().setFromObject(obj).getBoundingSphere(new THREE.Sphere());
      const dist = (sphere.radius || 0.5) / Math.sin(THREE.MathUtils.degToRad(35) / 2) * 1.1;
      cam.position.copy(sphere.center).add(new THREE.Vector3(1, 0.55, 1.15).normalize().multiplyScalar(dist));
      cam.lookAt(sphere.center);
      r.render(scene, cam);
      out.set(spec.id, r.domElement.toDataURL('image/png'));
      scene.remove(obj);
    } catch (e) { console.warn(`[preview] failed for ${spec.id}`, e); }
  }
  r.dispose();
  r.forceContextLoss?.();
  return out;
}
