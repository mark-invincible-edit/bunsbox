// main.js - bootstrap, game session, input, main loop.
import * as THREE from 'three';
import { NET, PLAYER, LIMITS, NPC, NEXTBOT, ITEMS_CFG as IC, keyIs, TEXTURE_FILES, SOUND_NAMES } from './config.js';
import { SPAWNABLES, getSpawnable } from './spawnables.js';
import { ITEMS, Inventory, ViewModel } from './items.js';
import * as assets from './assets.js';
import * as audio from './audio.js';
import { track, failed, missing, retryFailed } from './loader.js';
import { MAPS, buildMap } from './maps.js';
import { customMapToDef, buildCustom, entitiesOf, normalizeMap, normalizePart } from './mapfile.js';
import { Physics } from './physics.js';
import { LocalPlayer } from './player.js';
import { Effects, Beam, loadExplosionImage } from './effects.js';
import { Net, RemotePlayers, friendlyError } from './network.js';
import { Npcs, updateNextbots } from './npcs.js';
import { generatePreviews } from './preview.js';
import { Builder } from './builder.js';
import { safeImageUrl } from './imgutil.js';
import * as ui from './ui.js';

const now = () => performance.now() / 1000;
const r3 = v => Math.round(v * 1000) / 1000;
const okVec = a => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
const okQuat = a => Array.isArray(a) && a.length === 4 && a.every(Number.isFinite);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const _tip = new THREE.Vector3(), _tip2 = new THREE.Vector3();

// ---------------------------------------------------------------- renderer
const canvas = document.getElementById('game');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch (e) {
  ui.fatal('webgl is not available in this browser, the game cannot start.');
  throw e;
}
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(ui.settings.fov, 1, 0.05, 600);
camera.rotation.order = 'YXZ';
scene.add(camera);                                   // camera must be in the scene so the viewmodel renders
function resize() { renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
addEventListener('resize', resize); resize();

// ---------------------------------------------------------------- state
let game = null;           // active session or null
let locked = false;        // pointer lock
let builder = null;        // map editor (created on first use)
let fromBuilder = false;   // a singleplayer test of the builder map is running
const keys = new Set();

// ---------------------------------------------------------------- boot: load everything, tell the player what timed out
const loadExplosion = () => track('image', 'explosion', async () => {
  const r = await Promise.race([loadExplosionImage().then(t => t ? 'ok' : 'missing'), new Promise(res => setTimeout(() => res('timeout'), 15000))]);
  return { status: r, detail: r === 'timeout' ? 'stalled' : '' };
});

async function loadAll() {
  audio.setVolume(ui.settings.volume);
  const models = [...new Set([...SPAWNABLES.map(s => s.glb).filter(Boolean), ...Object.values(ITEMS).map(i => i.glb), 'plr.glb'])];
  const jobs = [...TEXTURE_FILES.map(assets.loadTexture), ...models.map(assets.loadModel), ...SOUND_NAMES.map(audio.load), loadExplosion()];
  let done = 0;
  jobs.forEach(p => p.then(() => ui.setLoading(++done / jobs.length, `loading assets ${done}/${jobs.length}`)));
  await Promise.all(jobs);          // every job resolves: idle timeouts + a download pool mean nothing can hang forever
}

async function toTitle() {
  ui.hideLoadProblems();
  ui.setLoading(1, 'rendering previews...');
  await new Promise(r => setTimeout(r, 30));          // let the loading text paint
  try { ui.setPreviews(generatePreviews()); } catch (e) { console.warn('[preview] failed', e); }
  ui.setAssetWarning(failed().length);
  ui.showTitle();
}

async function afterLoad() {
  const bad = failed();
  if (bad.length) { ui.showLoadProblems(bad, missing().length); return; }
  await toTitle();
}

async function retryAssets() {
  ui.showScreen('loading');
  ui.hideLoadProblems();
  ui.setLoading(0, 'retrying failed assets...');
  await retryFailed((d, n) => ui.setLoading(d / n, `retrying ${d}/${n}`));
  const bad = failed();
  if (bad.length) ui.showLoadProblems(bad, missing().length); else await toTitle();
}

// ---------------------------------------------------------------- map builder
function openBuilder(bm) {
  if (!builder) {
    builder = new Builder(renderer, canvas, {
      onExit: () => { builder.close(); ui.showTitle(); },
      onTest: m => { builder.close(); fromBuilder = true; startSession({ mode: 'sp', mapDef: customMapToDef(m) }); lock(); },
    });
  }
  ui.showScreen('none');
  builder.open(bm);
}

// ---------------------------------------------------------------- sessions
function pickSpawn(map) { return map.spawns[Math.floor(Math.random() * map.spawns.length)]; }

function startSession({ mode, mapDef, net = null, name = 'player', code = '', welcome = null }) {
  endSession();
  const map = mapDef;
  const authority = mode !== 'client';
  const group = new THREE.Group();
  scene.add(group);
  scene.background = new THREE.Color(map.sky);
  scene.fog = new THREE.Fog(map.fog.color, map.fog.near, map.fog.far);

  const hemi = new THREE.HemisphereLight(map.hemi[0], map.hemi[1], map.hemi[2]);
  const sun = new THREE.DirectionalLight(map.sun, map.sunI);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 1, far: 150 });
  sun.shadow.bias = -0.0004;
  group.add(hemi, sun, sun.target);

  const physics = new Physics(group, authority);
  let hazards = [];
  if (map.custom) { hazards = buildCustom(map.custom, { group, physics }); hazards.forEach((hz, i) => { hz.id = 'h' + i; }); }
  else buildMap(map, { group, physics });

  const player = new LocalPlayer(physics, camera);
  player.spawn(pickSpawn(map));
  player.onRespawn = () => player.spawn(pickSpawn(map));
  player.onHurt = () => ui.flashHurt();
  player.onDeath = () => { grabEnd(); clearJointSel(); };
  const effects = new Effects(group);
  const remote = new RemotePlayers(group);
  const vm = new ViewModel(camera);

  game = { mode, map, custom: map.custom || null, hazards, hitCd: new Map(), hitT: 0, group, sun, physics, player, effects, remote, vm, net, name, code, myProps: [], names: new Map(),
    npcs: authority ? new Npcs(group, physics) : null, npcView: authority ? null : new RemotePlayers(group),
    paused: false, modal: false, spawnHeld: false, tickAcc: 0, myId: welcome ? welcome.you : 0, lastHP: -1,
    inv: null, beams: new Map(), grab: null, grabTarget: null, jointSel: null, crowbarCd: 0, gunCd: 0, mouseDown: false };
  const g = game;
  g.inv = new Inventory(onInvChange);

  if (authority) {
    physics.hooks.onSpawn = p => {
      handleSpawnFx(p);
      if (p.owner === 0) g.myProps.push(p.id);
      net?.broadcast({ t: 'spawned', id: p.id, key: p.key, d: p.data || null, p: [r3(p.body.position.x), r3(p.body.position.y), r3(p.body.position.z)],
        q: [r3(p.body.quaternion.x), r3(p.body.quaternion.y), r3(p.body.quaternion.z), r3(p.body.quaternion.w)], by: p.owner });
    };
    physics.hooks.onRemove = id => net?.broadcast({ t: 'removed', id });
    physics.hooks.onClear = () => { g.myProps.length = 0; net?.broadcast({ t: 'cleared' }); };
    physics.hooks.onThruster = (id, on) => { net?.broadcast({ t: 'thr', id, on }); };
    physics.hooks.onExplosion = (pos, ex) => {
      const e = { radius: ex.radius, force: ex.force, damage: ex.damage };
      handleExplosion(pos, e);
      net?.broadcast({ t: 'boom', p: [r3(pos.x), r3(pos.y), r3(pos.z)], ex: e });
    };
    if (map.custom) {                                   // props + loose parts from the map file (clients get them in the welcome packet)
      for (const e of entitiesOf(map.custom)) physics.spawnProp(e.key, e.pos, 0, { quat: e.quat, data: e.data, mass: e.mass, anchored: e.anchored, bouncy: e.bouncy, silent: true, force: true, owner: -2, map: true });
    }
  }

  if (welcome) {   // late joiner: rebuild the current world
    for (const p of welcome.players) { g.names.set(p.id, p.name); if (p.id !== welcome.you) remote.add(p.id, p.name); }
    for (const p of welcome.props) {
      physics.spawnProp(p.key, p.p, 0, { id: p.id, quat: okQuat(p.q) ? p.q : null, owner: -1, silent: true, data: cleanRemoteData(p.d), map: !!p.m });
      if (p.a) physics.setThruster(p.id, true);
    }
  }

  ui.setOwner(authority);
  ui.showHUD(true);
  ui.setRoom(code);
  ui.setPlayers(1 + remote.map.size);
  ui.setHotbar(g.inv.list, g.inv.sel);
  audio.startAmbient();
  audio.unlock();
}

function endSession() {
  if (!game) return;
  const g = game;
  game = null;                          // handlers check this first, so late messages are ignored
  try { g.net?.close(); } catch (e) {}
  keys.clear();
  try { document.exitPointerLock?.(); } catch (e) {}
  audio.stopAmbient();
  g.remote.clear(); g.npcView?.clear(); g.npcs?.clear();
  g.vm.set(null); camera.remove(g.vm.root);
  scene.remove(g.group);
  g.group.traverse(o => { if (o.geometry) o.geometry.dispose?.(); });
  scene.fog = null; scene.background = null;
  ui.setPrompt(null);
  ui.hideGameUI();
}

// ---------------------------------------------------------------- effects / fx
function handleExplosion(pos, ex) {
  const g = game; if (!g) return;
  g.effects.explosion(pos, ex.radius);
  audio.play('explosion', { at: pos, volume: 1 });
  const d = camera.position.distanceTo(new THREE.Vector3(pos.x, pos.y, pos.z));
  g.effects.shake = Math.max(g.effects.shake, Math.max(0, 1 - d / (ex.radius * 3)) * 0.6);
  g.player.applyBlast(pos, ex);
  g.npcs?.blast(pos, ex);
}
function handleSpawnFx(p) { audio.play('spawn', { at: p.body.position }); }

// ---------------------------------------------------------------- aiming + helpers
function aim(reach = LIMITS.REACH) {
  const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
  return { dir, hit: game.physics.raycastRay(camera.position, dir, reach) };
}
const propAt = hit => (hit && hit.body.propId !== undefined) ? game.physics.props.get(hit.body.propId) : null;

// everything a bullet / crowbar can hit besides props: other players and npcs
function entities(excludeId) {
  const g = game, out = [];
  for (const [id, r] of g.remote.map) if (id !== excludeId) out.push({ kind: 'player', id, pos: r.av.group.position, dead: r.av.state === 'dead' });
  if (excludeId !== g.myId) out.push({ kind: 'player', id: g.myId, pos: g.player.body.position, dead: g.player.dead });
  if (g.npcs) for (const n of g.npcs.list.values()) out.push({ kind: 'npc', id: n.id, pos: n.body.position, dead: n.hp <= 0 });
  else for (const [id, r] of g.npcView.map) out.push({ kind: 'npc', id, pos: r.av.group.position, dead: r.av.state === 'dead' });
  return out;
}
function raySphere(o, d, cx, cy, cz, rad) {
  const ox = cx - o.x, oy = cy - o.y, oz = cz - o.z, tca = ox * d.x + oy * d.y + oz * d.z;
  if (tca < 0) return null;
  const d2 = ox * ox + oy * oy + oz * oz - tca * tca;
  if (d2 > rad * rad) return null;
  return Math.max(0, tca - Math.sqrt(rad * rad - d2));
}
function rayHitEntities(origin, dir, maxDist, excludeId) {
  let best = null;
  for (const e of entities(excludeId)) {
    if (e.dead) continue;
    for (const [cy, rad] of [[0.5, 0.5], [1.25, 0.45]]) {          // two spheres per body
      const t = raySphere(origin, dir, e.pos.x, e.pos.y + cy, e.pos.z, rad);
      if (t !== null && t <= maxDist && (!best || t < best.dist)) best = { kind: e.kind, id: e.id, dist: t };
    }
  }
  return best;
}
function people() {                                  // living-or-not targets for npc + nextbot ai (authority only)
  const g = game, p = g.player.body.position, out = [{ id: g.myId, x: p.x, y: p.y, z: p.z, dead: g.player.dead }];
  for (const [id, r] of g.remote.map) { const q = r.av.group.position; out.push({ id, x: q.x, y: q.y, z: q.z, dead: r.av.state === 'dead' }); }
  return out;
}

// ---------------------------------------------------------------- contact damage (map hazards + props/parts with damage > 0). authority only.
const _tq = new THREE.Quaternion(), _tp = new THREE.Vector3(), _tc = new THREE.Vector3();
function touching(src, feet) {                       // two spheres per body, same as the player collider
  for (const [cy, r] of [[0.45, 0.45], [1.3, 0.4]]) {
    _tp.set(feet.x, feet.y + cy, feet.z);
    if (src.sphere) { if (_tp.distanceTo(src.pos) < src.half[0] + r) return true; continue; }
    _tc.copy(_tp).sub(src.pos).applyQuaternion(_tq.copy(src.quat).invert());
    const hx = clamp(_tc.x, -src.half[0], src.half[0]), hy = clamp(_tc.y, -src.half[1], src.half[1]), hz = clamp(_tc.z, -src.half[2], src.half[2]);
    if (Math.hypot(_tc.x - hx, _tc.y - hy, _tc.z - hz) < r + 0.02) return true;
  }
  return false;
}
function contactDamage(dt) {
  const g = game;
  g.hitT += dt;
  const srcs = g.hazards.slice();
  for (const p of g.physics.props.values()) {
    const dmg = p.data?.damage;
    if (!(dmg > 0)) continue;
    const s = p.spec, b = p.body.position, q = p.body.quaternion;
    srcs.push({ id: 'p' + p.id, pos: new THREE.Vector3(b.x, b.y, b.z), quat: new THREE.Quaternion(q.x, q.y, q.z, q.w), half: s.shape === 'sphere' ? [s.size[0]] : s.size, sphere: s.shape === 'sphere', damage: dmg });
  }
  if (!srcs.length) return;
  const T = [];
  if (!g.player.dead) T.push({ kind: 'player', id: g.myId, pos: g.player.body.position });
  for (const [id, r] of g.remote.map) if (r.av.state !== 'dead') T.push({ kind: 'player', id, pos: r.av.group.position });
  for (const n of g.npcs.list.values()) if (n.hp > 0) T.push({ kind: 'npc', id: n.id, pos: n.body.position });
  for (const s of srcs) for (const t of T) {
    if (!touching(s, t.pos)) continue;
    const k = `${s.id}|${t.kind}${t.id}`;
    if ((g.hitCd.get(k) || 0) > g.hitT) continue;
    g.hitCd.set(k, g.hitT + 0.5);
    const dx = t.pos.x - s.pos.x, dz = t.pos.z - s.pos.z, l = Math.hypot(dx, dz) || 1;
    deliverHit(t.kind, t.id, [dx / l, 0.3, dz / l], s.damage, { x: s.pos.x, z: s.pos.z });
  }
  if (g.hitCd.size > 500) g.hitCd.clear();
}

// ---------------------------------------------------------------- spawning
function cleanData(spec, data) {                     // nextbot data. null = not a nextbot, undefined = invalid
  if (!spec.nextbot) return null;
  if (!data || !safeImageUrl(data.url)) return undefined;
  return { url: data.url, speed: clamp(Number(data.speed) || NEXTBOT.SPEED_DEFAULT, NEXTBOT.SPEED_MIN, NEXTBOT.SPEED_MAX) };
}
function cleanRemoteData(d) {                        // data the host sent us: only keep what we understand
  if (!d || typeof d !== 'object') return null;
  const out = {};
  if (safeImageUrl(d.url)) { out.url = d.url; out.speed = Number(d.speed) || 0; }
  if (d.part) { const p = normalizePart(d.part); if (p) out.part = p; }
  return Object.keys(out).length ? out : null;
}

// authority only. returns an error string or null
function spawnLocal(g, key, pos, yaw, owner, data) {
  const spec = getSpawnable(key);
  if (!spec) return 'unknown item';
  if (spec.npc) {
    if (!g.npcs.spawn(pos, yaw + Math.PI)) return `npc limit reached (${NPC.MAX})`;
    audio.play('spawn', { at: { x: pos[0], y: pos[1], z: pos[2] } });
    return null;
  }
  const d = cleanData(spec, data);
  if (spec.nextbot && !d) return 'that image link is not valid';
  return g.physics.spawnProp(key, pos, yaw, { owner, data: d }) ? null : `prop limit reached (${LIMITS.MAX_PROPS})`;
}

function requestSpawn(key, data = null) {
  const g = game; if (!g || g.paused) return;
  const spec = getSpawnable(key); if (!spec) return;
  if ((spec.op || spec.dialog) && g.mode === 'client') { ui.toast('only the server owner can spawn that'); return; }
  const { dir, hit } = aim();
  const hh = spec.npc ? 0.02 : spec.shape === 'sphere' ? spec.size[0] : spec.size[1];
  let pos;
  if (hit) pos = [hit.point.x + hit.normal.x * (hh + 0.05), hit.point.y + hit.normal.y * (hh + 0.05), hit.point.z + hit.normal.z * (hh + 0.05)];
  else pos = [camera.position.x + dir.x * 4, camera.position.y + dir.y * 4, camera.position.z + dir.z * 4];
  if (g.mode === 'client') { g.net.send({ t: 'spawn', key, p: pos, yaw: g.player.yaw }); return; }
  const err = spawnLocal(g, key, pos, g.player.yaw, 0, data);
  if (err) ui.toast(err);
}

function openNextbotDialog(key) {
  const g = game; if (!g || g.mode === 'client') return;
  closeSpawnMenu(false);
  g.modal = true; g.mouseDown = false; keys.clear();
  ui.openNextbot(
    ({ url, speed }) => requestSpawn(key, { url, speed }),
    () => { if (!game) return; game.modal = false; lock(); });
}

function removeById(id) {
  const g = game;
  if (g.mode === 'client') g.net.send({ t: 'remove', id }); else g.physics.removeProp(id);
}
function removeAimed() { const p = propAt(aim().hit); if (p) removeById(p.id); }
function undo() {
  const g = game;
  while (g.myProps.length) { const id = g.myProps.pop(); if (g.physics.props.has(id)) { removeById(id); return; } }
  ui.toast('nothing to undo');
}
function clearAll() {
  const g = game; if (!g) return;
  if (g.mode === 'client') g.net.send({ t: 'clear' }); else g.physics.clearProps();
}
function detonateAimed() {
  const g = game, p = propAt(aim().hit);
  if (!p?.spec.explosive) { ui.toast('aim at an explosive'); return; }
  if (g.mode === 'client') g.net.send({ t: 'det', id: p.id }); else g.physics.detonate(p.id);
}

// ---------------------------------------------------------------- E key: pick up / sit / thruster
function interactTarget() {
  const p = propAt(aim(IC.USE_REACH).hit);
  if (!p) return null;
  if (p.spec.item) return { prop: p, kind: 'item' };
  if (p.spec.thruster) return { prop: p, kind: 'thruster' };
  if (p.spec.seat) return { prop: p, kind: 'seat' };
  return null;
}
function giveItem(item) {
  if (!game || !ITEMS[item]) return;
  if (game.inv.add(item)) { audio.play('pickup'); ui.toast(`picked up: ${ITEMS[item].name}`); }
}
function toggleThruster(id) {
  const g = game;
  if (g.mode === 'client') g.net.send({ t: 'use', id }); else g.physics.toggleThruster(id);
  audio.play('thruster');
}
function useKey() {
  const g = game; if (!g || g.paused || g.player.dead) return;
  const t = interactTarget();
  if (g.player.seat) { if (t?.kind === 'thruster') toggleThruster(t.prop.id); else g.player.unseat(); return; }
  if (!t) return;
  if (t.kind === 'item') {
    const spec = t.prop.spec, item = spec.item;
    if (spec.op && g.mode === 'client') { ui.toast('only the server owner can pick that up'); return; }
    if (g.inv.has(item)) { ui.toast(`you already have the ${ITEMS[item].name.toLowerCase()}`); return; }
    if (g.mode === 'client') g.net.send({ t: 'use', id: t.prop.id });      // host removes it and sends us a 'give'
    else { g.physics.removeProp(t.prop.id); giveItem(item); }
  } else if (t.kind === 'seat') g.player.sit(t.prop);
  else toggleThruster(t.prop.id);
}

// ---------------------------------------------------------------- items
function onInvChange() {
  const g = game; if (!g) return;
  const cur = g.inv.current;
  ui.setHotbar(g.inv.list, g.inv.sel);
  g.vm.set(cur);
  if (cur !== 'physgun') grabEnd();
  if (g.jointSel && g.jointSel.kind !== cur) clearJointSel();
}

function primaryDown() {
  const g = game, it = g.inv.current;
  if (!it || g.player.dead) return;
  if (it === 'crowbar') crowbarSwing();
  else if (it === 'physgun') grabStart();
  else if (it === 'glue' || it === 'hinge') jointClick(it);
  // guns fire from the update loop while LMB is held
}
function secondaryDown() {
  const g = game, it = g.inv.current;
  if ((it === 'glue' || it === 'hinge') && !g.player.dead) jointRight();
}

// --- hits (host decides the damage numbers, clients only say who/where)
function deliverHit(kind, target, d, dmg, from) {
  const g = game; if (!g) return;
  if (kind === 'npc') { g.npcs?.hurt(target, dmg, { x: d[0], y: d[1], z: d[2] }, from); return; }
  if (target === g.myId) g.player.hurt(dmg, d);
  else { const c = g.net?.clients.get(target); if (c) g.net.sendTo(c, { t: 'hurt', dmg, d }); }
}

// --- crowbar
function crowbarSwing() {
  const g = game, C = IC.CROWBAR;
  if (g.crowbarCd > 0) return;
  g.crowbarCd = C.COOLDOWN; g.vm.swingNow(); audio.play('swing');
  const { dir, hit } = aim(C.REACH);
  const ent = rayHitEntities(camera.position, dir, C.REACH, g.myId);
  const d = [dir.x, dir.y, dir.z];
  if (ent && (!hit || ent.dist < hit.dist)) {
    audio.play('hit');
    if (g.mode === 'client') g.net.send({ t: 'hit', kind: ent.kind, target: ent.id, d });
    else deliverHit(ent.kind, ent.id, d, C.DAMAGE, camera.position);
    return;
  }
  const p = propAt(hit);
  if (!p) return;
  audio.play('hit');
  if (g.mode === 'client') g.net.send({ t: 'melee', id: p.id, d }); else meleeProp(p.id, d);
}
function meleeProp(id, d) {           // authority: knock the prop back, set off explosives
  const g = game, p = g.physics.props.get(id);
  if (!p) return;
  g.physics.knockProp(id, { x: d[0], y: d[1], z: d[2] }, IC.CROWBAR.KNOCK);
  if (p.spec.explosive) g.physics.detonate(id);
}

// --- guns: hold LMB. muzzle flash at the barrel tip, hitscan on the host.
function gunFire() {
  const g = game, it = g.inv.current, cfg = IC[ITEMS[it].gun];
  if (g.gunCd > 0 || g.player.dead) return;
  g.gunCd = cfg.COOLDOWN;
  const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
  const wr = g.physics.raycastRay(camera.position, dir, cfg.RANGE);
  const end = wr ? new THREE.Vector3(wr.point.x, wr.point.y, wr.point.z) : camera.position.clone().addScaledVector(dir, 60);
  g.vm.recoilNow(); audio.play('shoot');
  if (g.vm.tip(_tip)) { _tip.addScaledVector(dir, 0.07); g.effects.muzzle(_tip, 0.22); g.effects.tracer(_tip, end); }
  const o = [r3(camera.position.x), r3(camera.position.y), r3(camera.position.z)], d = [r3(dir.x), r3(dir.y), r3(dir.z)];
  if (g.mode === 'client') g.net.send({ t: 'shoot', o, d, w: it }); else doShoot(g.myId, o, d, it);
}
function doShoot(owner, o, d, itemId) {               // authority
  const g = game, def = ITEMS[itemId];
  if (!g || !def?.gun) return;
  const cfg = IC[def.gun], origin = new THREE.Vector3(...o), dir = new THREE.Vector3(...d);
  if (dir.lengthSq() < 1e-6) return;
  dir.normalize();
  const wr = g.physics.raycastRay(origin, dir, cfg.RANGE), wd = wr ? wr.dist : cfg.RANGE;
  const ent = rayHitEntities(origin, dir, wd, owner);
  let end;
  if (ent) {
    end = origin.clone().addScaledVector(dir, ent.dist);
    deliverHit(ent.kind, ent.id, [dir.x, dir.y, dir.z], cfg.DAMAGE, origin);
  } else if (wr) {
    end = new THREE.Vector3(wr.point.x, wr.point.y, wr.point.z);
    const p = propAt(wr);
    if (p) g.physics.knockProp(p.id, dir, cfg.KNOCK);   // small shove
  } else end = origin.clone().addScaledVector(dir, wd);
  g.net?.broadcast({ t: 'shot', by: owner, e: [r3(end.x), r3(end.y), r3(end.z)] });
  if (owner !== g.myId) shotFx(owner, end);
}
function shotFx(by, end) {                            // somebody else fired: flash at the tip of the item in their hand
  const g = game, r = g.remote.map.get(by);
  if (!r || !r.av.itemTip(_tip2)) return;
  const dir = new THREE.Vector3().subVectors(end, _tip2).normalize();
  _tip2.addScaledVector(dir, 0.07);
  g.effects.muzzle(_tip2, 0.45); g.effects.tracer(_tip2, end);
  audio.play('shoot', { at: _tip2 });
}

// --- physics gun
function grabStart() {
  const g = game, P = IC.PHYSGUN;
  const { hit } = aim(P.REACH), p = propAt(hit);
  if (!p || p.anchored) return;
  g.grab = { id: p.id, dist: clamp(hit.dist, P.MIN_DIST, P.MAX_DIST) };
  if (g.mode === 'client') g.net.send({ t: 'grab', id: p.id }); else g.physics.startGrab(0, p.id);
}
function grabEnd() {
  const g = game; if (!g || !g.grab) return;
  g.grab = null; g.grabTarget = null;
  if (g.mode === 'client') g.net.send({ t: 'rel' }); else g.physics.endGrab(0);
}
function updateGrab() {
  const g = game; if (!g.grab) return;
  if (!g.physics.props.has(g.grab.id) || g.player.dead) { grabEnd(); return; }
  const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
  const t = [camera.position.x + dir.x * g.grab.dist, camera.position.y + dir.y * g.grab.dist, camera.position.z + dir.z * g.grab.dist];
  if (g.mode === 'client') g.grabTarget = t; else g.physics.setGrabTarget(0, t);
}

// --- glue + hinge share the two-click flow
function selectJoint(kind, prop, pt) {
  const g = game, helper = new THREE.BoxHelper(prop.mesh, 0x66ccff);
  g.group.add(helper);
  g.jointSel = { kind, prop, helper, point: [pt.x, pt.y, pt.z] };
}
function clearJointSel() {
  const g = game; if (!g?.jointSel) return;
  g.group.remove(g.jointSel.helper); g.jointSel.helper.dispose?.(); g.jointSel = null;
}
function jointClick(kind) {
  const g = game, reach = kind === 'hinge' ? IC.HINGE.REACH : IC.GLUE_REACH;
  const { hit } = aim(reach), p = propAt(hit);
  if (!g.jointSel) {
    if (!p) { ui.toast('aim at a prop'); return; }
    selectJoint(kind, p, hit.point); audio.play('click');
    ui.toast(kind === 'hinge' ? 'now click where the second prop (or a wall) meets it' : 'now pick the second prop');
    return;
  }
  const a = g.jointSel.prop.id, p1 = g.jointSel.point;
  if (kind === 'glue') {
    if (!p) { ui.toast('aim at a prop'); return; }
    if (p.id === a) { ui.toast('pick a different prop'); return; }
    clearJointSel(); audio.play('glue');
    if (g.mode === 'client') g.net.send({ t: 'glue', a, b: p.id });
    else ui.toast(g.physics.glue(a, p.id) ? 'glued' : 'those are already glued');
  } else {
    if (!hit) { ui.toast('aim at a prop or a wall'); return; }
    if (p && p.id === a) { ui.toast('pick a different prop'); return; }
    const b = p ? p.id : null, p2 = [hit.point.x, hit.point.y, hit.point.z];
    clearJointSel(); audio.play('hinge');
    if (g.mode === 'client') g.net.send({ t: 'hinge', a, b, p1, p2 });
    else ui.toast(g.physics.hinge(a, b, p1, p2) || 'hinged');
  }
}
function jointRight() {
  const g = game;
  if (g.jointSel) { clearJointSel(); ui.toast('cancelled'); return; }
  const p = propAt(aim(IC.GLUE_REACH).hit);
  if (!p) return;
  if (g.mode === 'client') { g.net.send({ t: 'unglue', id: p.id }); ui.toast('joints removed'); }
  else ui.toast(g.physics.unglue(p.id) ? 'joints removed' : 'nothing attached to that');
}

// ---------------------------------------------------------------- nextbot kills
function killPerson(person) {
  const g = game;
  if (person.id === g.myId) g.player.damage(9999);
  else { const c = g.net?.clients.get(person.id); if (c) g.net.sendTo(c, { t: 'hurt', dmg: 9999, d: [0, 1, 0] }); }
}

// ---------------------------------------------------------------- network handlers
const updateCount = () => game && ui.setPlayers(1 + game.remote.map.size);
const netHandlers = {
  // ---- host side
  getWelcome() {
    const g = game; if (!g) return null;
    return {
      map: g.custom ? 'custom' : g.map.id,
      custom: g.custom || null,                          // the whole map file travels to the joiner
      players: [{ id: 0, name: g.name }, ...[...g.net.clients.values()].map(c => ({ id: c.id, name: c.name }))],
      props: [...g.physics.props.values()].map(p => ({ id: p.id, key: p.key, a: p.active ? 1 : 0, m: p.map ? 1 : 0, d: p.data || null,
        p: [p.body.position.x, p.body.position.y, p.body.position.z],
        q: [p.body.quaternion.x, p.body.quaternion.y, p.body.quaternion.z, p.body.quaternion.w] })),
    };
  },
  onPlayerJoin(c) { const g = game; if (!g) return; g.names.set(c.id, c.name); g.remote.add(c.id, c.name); g.physics.addRemoteBody(c.id); ui.toast(`${c.name} joined`); updateCount(); },
  onPlayerLeave(c) { const g = game; if (!g) return; g.physics.endGrab(c.id); g.remote.remove(c.id); g.physics.removeRemoteBody(c.id); ui.toast(`${c.name} left`); updateCount(); },
  onClientState(c, m) {
    if (!game || !okVec(m.p) || !Number.isFinite(m.yaw) || !Number.isFinite(m.pitch)) return;
    game.remote.push(c.id, m, now());
  },
  onSpawnReq(c, m) {
    const g = game; if (!g || typeof m.key !== 'string' || !okVec(m.p) || !Number.isFinite(m.yaw)) return;
    const spec = getSpawnable(m.key); if (!spec) return;
    if (spec.op || spec.dialog) { g.net.sendTo(c, { t: 'toast', msg: 'only the server owner can spawn that' }); return; }
    const err = spawnLocal(g, m.key, m.p, m.yaw, c.id, null);
    if (err) g.net.sendTo(c, { t: 'toast', msg: err });
  },
  onRemoveReq(c, m) { game?.physics.removeProp(m.id); },
  onClearReq() { game?.physics.clearProps(); },
  onDetReq(c, m) { game?.physics.detonate(m.id); },
  onUseReq(c, m) {
    const g = game, p = g?.physics.props.get(m.id);
    if (!p) return;
    if (p.spec.item) {
      if (p.spec.op) { g.net.sendTo(c, { t: 'toast', msg: 'only the server owner can pick that up' }); return; }
      g.physics.removeProp(m.id); g.net.sendTo(c, { t: 'give', item: p.spec.item });
    } else if (p.spec.thruster) g.physics.toggleThruster(m.id);
  },
  onGrabReq(c, m) { game?.physics.startGrab(c.id, m.id); },
  onGrabTarget(c, m) { if (okVec(m.p)) game?.physics.setGrabTarget(c.id, m.p); },
  onGrabRelease(c) { game?.physics.endGrab(c.id); },
  onMeleeReq(c, m) { if (game && okVec(m.d)) meleeProp(m.id, m.d); },
  onHitReq(c, m) {
    const g = game; if (!g || !okVec(m.d) || (m.kind !== 'npc' && m.kind !== 'player') || !Number.isFinite(m.target)) return;
    const r = g.remote.map.get(c.id);
    deliverHit(m.kind, m.target, m.d, IC.CROWBAR.DAMAGE, r ? r.av.group.position : null);   // damage comes from config, never from the client
  },
  onShootReq(c, m) { if (game && okVec(m.o) && okVec(m.d) && typeof m.w === 'string') doShoot(c.id, m.o, m.d, m.w); },
  onGlueReq(c, m) { const g = game; if (g && g.physics.glue(m.a, m.b)) g.net.sendTo(c, { t: 'toast', msg: 'glued' }); },
  onHingeReq(c, m) {
    const g = game; if (!g || !okVec(m.p1) || !okVec(m.p2) || !Number.isFinite(m.a) || !(m.b === null || Number.isFinite(m.b))) return;
    g.net.sendTo(c, { t: 'toast', msg: g.physics.hinge(m.a, m.b, m.p1, m.p2) || 'hinged' });
  },
  onUnglueReq(c, m) { game?.physics.unglue(m.id); },

  // ---- client side
  onSnap(m) {
    const g = game; if (!g || g.mode !== 'client') return;
    const t = now();
    for (const e of m.pl || []) {
      if (e[0] === g.myId) continue;
      if (!g.remote.map.has(e[0])) g.remote.add(e[0], g.names.get(e[0]) || 'player');
      g.remote.push(e[0], { p: [e[1], e[2], e[3]], yaw: e[4], pitch: e[5], an: e[6], it: e[7] || null, gr: e[8] || 0, tq: e[9] || null }, t);
    }
    const seen = new Set();
    for (const e of m.np || []) {
      if (!Array.isArray(e)) continue;
      seen.add(e[0]);
      if (!g.npcView.map.has(e[0])) g.npcView.add(e[0], 'npc');
      g.npcView.push(e[0], { p: [e[1], e[2], e[3]], yaw: e[4], pitch: 0, an: String(e[5]), it: e[6] || null, gr: 0, tq: null }, t);
    }
    for (const id of [...g.npcView.map.keys()]) if (!seen.has(id)) g.npcView.remove(id);
    g.physics.applyPropStates(m.pr, t);
    updateCount();
  },
  onSpawned(m) {
    const g = game; if (!g || g.mode !== 'client') return;
    const p = g.physics.spawnProp(m.key, m.p, 0, { id: m.id, quat: okQuat(m.q) ? m.q : null, owner: m.by, silent: true, data: cleanRemoteData(m.d) });
    if (!p) return;
    handleSpawnFx(p);
    if (m.by === g.myId) g.myProps.push(m.id);
  },
  onRemoved(m) { game?.physics.removeProp(m.id, true); },
  onCleared() { if (game) { game.physics.clearProps(); game.myProps.length = 0; } },
  onBoom(m) { if (game && okVec(m.p)) handleExplosion({ x: m.p[0], y: m.p[1], z: m.p[2] }, m.ex); },
  onShot(m) { const g = game; if (g && okVec(m.e) && m.by !== g.myId) shotFx(m.by, new THREE.Vector3(...m.e)); },
  onThruster(m) { game?.physics.setThruster(m.id, !!m.on); },
  onGive(m) { giveItem(m.item); },
  onHurt(m) { if (game && Number.isFinite(m.dmg) && okVec(m.d)) game.player.hurt(m.dmg, m.d); },
  onJoin(m) { const g = game; if (!g) return; g.names.set(m.id, m.name); g.remote.add(m.id, m.name); ui.toast(`${m.name} joined`); updateCount(); },
  onLeave(m) { const g = game; if (!g) return; g.remote.remove(m.id); ui.toast(`${g.names.get(m.id) || 'player'} left`); updateCount(); },
  onToast(m) { ui.toast(String(m.msg)); },
  onDisconnect(reason) { if (!game) return; fromBuilder = false; endSession(); ui.showTitle(reason); },
};

// ---------------------------------------------------------------- pointer lock, pause, input
function lock() {
  try {
    const p = canvas.requestPointerLock();
    if (p && p.catch) p.catch(() => ui.showLockHint(!!game && !game.paused && !game.modal));
  } catch (e) { ui.showLockHint(true); }
}
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  ui.showLockHint(!!game && !locked && !game.paused && !game.spawnHeld && !game.modal);
  if (game && !locked) game.mouseDown = false;
  if (game && !locked && !game.spawnHeld && !game.paused && !game.modal) pause();      // lost the lock (esc / alt-tab) -> pause menu
});
document.addEventListener('pointerlockerror', () => { if (game && !game.paused && !game.modal) ui.showLockHint(true); });
canvas.addEventListener('click', () => { if (game && !game.paused && !game.modal && !locked && !game.spawnHeld) lock(); });

function pause() {
  if (!game || game.paused) return;
  grabEnd();
  game.paused = true; game.mouseDown = false; keys.clear();
  ui.showLockHint(false); ui.showPause(true, game.code);
}
function resume() {
  if (!game) return;
  game.paused = false; ui.showPause(false); lock();
}
function openSpawnMenu() {
  const g = game; if (!g || g.paused || g.modal || g.player.dead) return;
  g.spawnHeld = true; g.mouseDown = false; ui.openSpawn(); document.exitPointerLock();
}
function closeSpawnMenu(relock = true) {
  const g = game; if (!g || !g.spawnHeld) return;
  g.spawnHeld = false; ui.closeSpawn();
  if (relock && !g.paused && !g.modal) lock();
}

addEventListener('keydown', e => {
  if (!game || game.modal) return;
  if (game.paused) { if (e.code === 'Escape') resume(); return; }
  if (keyIs(e.code, 'help')) { e.preventDefault(); if (!e.repeat) ui.toggleHelp(); return; }
  if (!locked && !game.spawnHeld) return;
  if (['Space', 'Tab'].includes(e.code) || e.code.startsWith('Arrow')) e.preventDefault();
  if (e.repeat) return;
  keys.add(e.code);
  if (keyIs(e.code, 'spawnMenu') && locked) openSpawnMenu();
  else if (keyIs(e.code, 'use') && locked) useKey();
  else if (keyIs(e.code, 'remove')) removeAimed();
  else if (keyIs(e.code, 'undo')) undo();
  else if (keyIs(e.code, 'detonate')) detonateAimed();
  else if (keyIs(e.code, 'clearAll')) clearAll();
});
addEventListener('keyup', e => {
  keys.delete(e.code);
  if (game?.spawnHeld && keyIs(e.code, 'spawnMenu')) closeSpawnMenu();
});
addEventListener('blur', () => { keys.clear(); if (game) game.mouseDown = false; closeSpawnMenu(false); });
document.addEventListener('mousemove', e => {
  if (locked && game && !game.paused) game.player.look(e.movementX, e.movementY, 0.0022 * ui.settings.sens);
});
addEventListener('mousedown', e => {
  if (!locked || !game || game.paused || game.modal) return;
  if (e.button === 0) { game.mouseDown = true; primaryDown(); } else if (e.button === 2) secondaryDown();
});
addEventListener('mouseup', e => { if (e.button === 0 && game) { game.mouseDown = false; if (game.grab) grabEnd(); } });
addEventListener('contextmenu', e => { if (game) e.preventDefault(); });
addEventListener('wheel', e => {
  if (!game || game.paused || game.modal || !locked) return;
  e.preventDefault();
  const dir = Math.sign(e.deltaY);
  if (game.grab) game.grab.dist = clamp(game.grab.dist - dir, IC.PHYSGUN.MIN_DIST, IC.PHYSGUN.MAX_DIST);   // physgun: scroll = distance
  else game.inv.cycle(dir > 0 ? 1 : -1);
}, { passive: false });
addEventListener('beforeunload', () => game?.net?.close());

// ---------------------------------------------------------------- ui wiring
const defFor = (mapId, custom) => custom ? customMapToDef(custom) : (MAPS.find(m => m.id === mapId) || MAPS[0]);
ui.init({
  onStartSP(mapId, custom) { startSession({ mode: 'sp', mapDef: defFor(mapId, custom) }); lock(); },
  async onHost(mapId, name, custom) {
    const net = new Net(netHandlers);
    try { const code = await net.host(name); startSession({ mode: 'host', mapDef: defFor(mapId, custom), net, name, code }); lock(); }
    catch (e) { net.close(); throw new Error(friendlyError(e)); }
  },
  async onJoin(code, name) {
    const net = new Net(netHandlers);
    try {
      const w = await net.join(code, name);
      let def;
      if (w.custom) { try { def = customMapToDef(normalizeMap(w.custom)); } catch (e) { throw new Error('the host sent a broken map file'); } }
      else def = defFor(w.map, null);
      startSession({ mode: 'client', mapDef: def, net, name, code: code.toUpperCase(), welcome: w }); lock();
    } catch (e) { net.close(); throw new Error(friendlyError(e)); }
  },
  onResume: resume,
  onExit() { endSession(); if (fromBuilder) { fromBuilder = false; openBuilder(); } else ui.showTitle(); },
  onSettings() { camera.fov = ui.settings.fov; camera.updateProjectionMatrix(); audio.setVolume(ui.settings.volume); },
  onSpawnItem(id) { const spec = getSpawnable(id); if (spec?.dialog === 'nextbot') openNextbotDialog(id); else requestSpawn(id); },
  onClearAll() { clearAll(); },
  onLockClick() { lock(); },
  onBuilder() { openBuilder(); },
  onRetryAssets: retryAssets,
  onContinueAssets: toTitle,
});
camera.fov = ui.settings.fov; camera.updateProjectionMatrix();

// ---------------------------------------------------------------- main loop
const clock = new THREE.Clock();
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (builder?.active) { builder.update(dt); renderer.render(builder.scene, builder.camera); return; }
  if (!game) return;
  update(dt);
  renderer.render(scene, camera);
}

function getBeam(key) {
  let b = game.beams.get(key);
  if (!b) { b = new Beam(game.group); game.beams.set(key, b); }
  return b;
}
function updateBeams(t) {
  const g = game;
  const mine = getBeam('me'), gp = g.grab ? g.physics.props.get(g.grab.id) : null;
  if (gp && g.inv.current === 'physgun' && !g.player.dead && g.vm.tip(_tip)) mine.update(_tip, gp.mesh.position, t); else mine.hide();
  for (const [id, r] of g.remote.map) {                     // everyone else's beams, from the item in their hand
    const b = getBeam(id), pr = r.grab ? g.physics.props.get(r.grab) : null;
    if (pr && r.av.itemTip(_tip2)) b.update(_tip2, pr.mesh.position, t); else b.hide();
  }
}
function updatePrompt() {
  const g = game;
  let text = null;
  if (locked && !g.paused && !g.modal && !g.spawnHeld && !g.player.dead) {
    const t = interactTarget(), k = ui.keyLabels('use');
    if (g.player.seat) text = t?.kind === 'thruster' ? `[${k}] toggle thruster` : `[${k}] stand up`;
    else if (t) {
      if (t.kind === 'item') text = t.prop.spec.op && g.mode === 'client' ? `${ITEMS[t.prop.spec.item].name} (server owner only)` : `[${k}] pick up ${ITEMS[t.prop.spec.item].name}`;
      else text = t.kind === 'seat' ? `[${k}] sit` : `[${k}] toggle thruster`;
    }
  }
  ui.setPrompt(text);
}

function update(dt) {
  const g = game, t = now();
  const sim = !(g.paused && g.mode === 'sp');      // singleplayer pause freezes the world, multiplayer cannot
  g.crowbarCd = Math.max(0, g.crowbarCd - dt); g.gunCd = Math.max(0, g.gunCd - dt);
  if (sim) {
    g.player.update(dt, keys, locked && !g.paused && !g.modal);
    if (g.npcs) {                                       // npc + nextbot ai + contact damage (authority only)
      const ppl = people();
      g.npcs.update(dt, ppl);
      updateNextbots(g.physics, dt, ppl, g.npcs, killPerson, (n, from) => g.npcs.hurt(n.id, 9999, { x: 0, y: 1, z: 0 }, from));
      contactDamage(dt);
    }
    g.physics.step(dt);
    if (g.mode === 'client') { g.physics.updateClient(t - NET.INTERP_DELAY); g.npcView.update(dt, t - NET.INTERP_DELAY); }
    g.remote.update(dt, t - NET.INTERP_DELAY);
    if (g.mode === 'host') for (const [id, r] of g.remote.map) g.physics.moveRemoteBody(id, r.av.group.position, dt);
  }
  g.player.placeCamera(dt);
  g.effects.update(dt);
  if (g.effects.shake > 0) {                          // blast shake
    const s = g.effects.shake * 0.12;
    camera.position.x += (Math.random() - 0.5) * s; camera.position.y += (Math.random() - 0.5) * s;
  }
  camera.updateMatrixWorld(true);
  audio.setListener(camera.position);

  const b = g.player.body, hs = Math.hypot(b.velocity.x, b.velocity.z);
  g.vm.update(dt, g.player.grounded ? hs : 0, !g.player.dead);
  if (g.mouseDown && locked && !g.paused && !g.modal && ITEMS[g.inv.current]?.gun) gunFire();
  updateGrab();
  updateBeams(t);
  if (g.jointSel) { if (!g.physics.props.has(g.jointSel.prop.id)) clearJointSel(); else g.jointSel.helper.update(); }
  updatePrompt();

  // sun follows the player so shadows stay sharp
  const p = b.position;
  g.sun.position.set(p.x + 30, p.y + 50, p.z + 20);
  g.sun.target.position.set(p.x, p.y, p.z);

  // hud
  if (g.player.hp !== g.lastHP) { g.lastHP = g.player.hp; ui.setHP(g.player.hp, PLAYER.MAX_HP); }
  ui.setDeath(g.player.dead ? `you died. respawning in ${Math.max(1, Math.ceil(g.player.deathTimer))}` : null);

  // network tick
  if (g.net) {
    g.tickAcc += dt;
    if (g.tickAcc >= 1 / NET.TICK_RATE) {
      g.tickAcc = 0;
      const me = g.player.netState(), it = g.inv.current || '', gr = g.grab ? g.grab.id : 0;
      if (g.mode === 'host') {
        const pl = [[0, r3(me.p[0]), r3(me.p[1]), r3(me.p[2]), r3(me.yaw), r3(me.pitch), me.an, it, gr, me.tq]];
        for (const c of g.net.clients.values()) {
          const s = c.state; if (!s) continue;
          pl.push([c.id, r3(s.p[0]), r3(s.p[1]), r3(s.p[2]), r3(s.yaw), r3(s.pitch), String(s.an), (typeof s.it === 'string' && ITEMS[s.it]) ? s.it : '', Number.isInteger(s.gr) ? s.gr : 0, okQuat(s.tq) ? s.tq : null]);
        }
        g.net.broadcast({ t: 'snap', pl, np: g.npcs.snapshot(), pr: g.physics.collectDelta() });
      } else if (g.mode === 'client') {
        g.net.send({ t: 'st', p: me.p.map(r3), yaw: r3(me.yaw), pitch: r3(me.pitch), an: me.an, it, gr, tq: me.tq });
        if (g.grab && g.grabTarget) g.net.send({ t: 'gt', p: g.grabTarget.map(r3) });
        if (t - g.net.lastRecv > NET.HOST_TIMEOUT) netHandlers.onDisconnect('lost connection to the host');
      }
    }
  }
}

loadAll().then(afterLoad);
frame();
