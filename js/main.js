// main.js - bootstrap, game session, input, main loop.
import * as THREE from 'three';
import { NET, PLAYER, LIMITS, KEYS, keyIs, TEXTURE_FILES, SOUND_NAMES } from './config.js';
import { SPAWNABLES, getSpawnable } from './spawnables.js';
import * as assets from './assets.js';
import * as audio from './audio.js';
import { MAPS, buildMap } from './maps.js';
import { Physics } from './physics.js';
import { LocalPlayer } from './player.js';
import { Effects } from './effects.js';
import { Net, RemotePlayers, friendlyError } from './network.js';
import * as ui from './ui.js';

const now = () => performance.now() / 1000;
const r3 = v => Math.round(v * 1000) / 1000;
const okVec = a => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);

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
function resize() { renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
addEventListener('resize', resize); resize();

// ---------------------------------------------------------------- state
let game = null;           // active session or null
let locked = false;        // pointer lock
const keys = new Set();

// ---------------------------------------------------------------- boot: preload everything, never block on failures
async function boot() {
  audio.setVolume(ui.settings.volume);
  const models = [...new Set([...SPAWNABLES.map(s => s.glb).filter(Boolean), 'plr.glb'])];
  const jobs = [...TEXTURE_FILES.map(assets.loadTexture), ...models.map(assets.loadModel), ...SOUND_NAMES.map(audio.load)];
  let done = 0;
  jobs.forEach(p => p.then(() => ui.setLoading(++done / jobs.length, `loading assets ${done}/${jobs.length}`)));
  await Promise.race([Promise.all(jobs), new Promise(r => setTimeout(r, 30000))]);   // hard cap, then go anyway
  ui.showTitle();
}

// ---------------------------------------------------------------- sessions
function pickSpawn(map) { return map.spawns[Math.floor(Math.random() * map.spawns.length)]; }

function startSession({ mode, mapId, net = null, name = 'player', code = '', welcome = null }) {
  endSession();
  const map = MAPS.find(m => m.id === mapId) || MAPS[0];
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
  buildMap(map, { group, physics });
  const player = new LocalPlayer(physics, camera);
  player.spawn(pickSpawn(map));
  player.onRespawn = () => player.spawn(pickSpawn(map));
  const effects = new Effects(group);
  const remote = new RemotePlayers(group);

  game = { mode, map, group, sun, physics, player, effects, remote, net, name, code, myProps: [], names: new Map(),
    paused: false, spawnHeld: false, tickAcc: 0, myId: welcome ? welcome.you : 0, lastHP: -1 };
  const g = game;

  if (authority) {
    physics.hooks.onSpawn = p => {
      handleSpawnFx(p);
      if (p.owner === 0) g.myProps.push(p.id);
      net?.broadcast({ t: 'spawned', id: p.id, key: p.key, p: [r3(p.body.position.x), r3(p.body.position.y), r3(p.body.position.z)],
        q: [r3(p.body.quaternion.x), r3(p.body.quaternion.y), r3(p.body.quaternion.z), r3(p.body.quaternion.w)], by: p.owner });
    };
    physics.hooks.onRemove = id => net?.broadcast({ t: 'removed', id });
    physics.hooks.onClear = () => { g.myProps.length = 0; net?.broadcast({ t: 'cleared' }); };
    physics.hooks.onExplosion = (pos, ex) => {
      const e = { radius: ex.radius, force: ex.force, damage: ex.damage };
      handleExplosion(pos, e);
      net?.broadcast({ t: 'boom', p: [r3(pos.x), r3(pos.y), r3(pos.z)], ex: e });
    };
  }

  if (welcome) {   // late joiner: rebuild the current world
    for (const p of welcome.players) { g.names.set(p.id, p.name); if (p.id !== welcome.you) remote.add(p.id, p.name); }
    for (const p of welcome.props) physics.spawnProp(p.key, p.p, 0, { id: p.id, quat: p.q, owner: -1, silent: true });
  }

  ui.showHUD(true);
  ui.setRoom(code);
  ui.setPlayers(1 + remote.map.size);
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
  g.remote.clear();
  scene.remove(g.group);
  g.group.traverse(o => { if (o.geometry) o.geometry.dispose?.(); });
  scene.fog = null; scene.background = null;
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
}
function handleSpawnFx(p) { audio.play('spawn', { at: p.body.position }); }

// ---------------------------------------------------------------- aiming + prop actions
function aim() {
  const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
  return { dir, hit: game.physics.raycastRay(camera.position, dir, LIMITS.REACH) };
}

function requestSpawn(key) {
  const g = game; if (!g || g.paused) return;
  const spec = getSpawnable(key); if (!spec) return;
  const { dir, hit } = aim();
  const hh = spec.shape === 'sphere' ? spec.size[0] : spec.size[1];
  let pos;
  if (hit) pos = [hit.point.x + hit.normal.x * (hh + 0.05), hit.point.y + hit.normal.y * (hh + 0.05), hit.point.z + hit.normal.z * (hh + 0.05)];
  else pos = [camera.position.x + dir.x * 4, camera.position.y + dir.y * 4, camera.position.z + dir.z * 4];
  if (g.mode === 'client') g.net.send({ t: 'spawn', key, p: pos, yaw: g.player.yaw });
  else if (!g.physics.spawnProp(key, pos, g.player.yaw, { owner: 0 })) ui.toast(`prop limit reached (${LIMITS.MAX_PROPS})`);
}

function removeById(id) {
  const g = game;
  if (g.mode === 'client') g.net.send({ t: 'remove', id }); else g.physics.removeProp(id);
}
function removeAimed() {
  const { hit } = aim();
  if (hit?.body?.propId !== undefined) removeById(hit.body.propId);
}
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
  const g = game;
  const { hit } = aim();
  const id = hit?.body?.propId;
  const p = id !== undefined ? g.physics.props.get(id) : null;
  if (!p?.spec.explosive) { ui.toast('aim at an explosive'); return; }
  if (g.mode === 'client') g.net.send({ t: 'det', id }); else g.physics.detonate(id);
}

// ---------------------------------------------------------------- network handlers
const updateCount = () => game && ui.setPlayers(1 + game.remote.map.size);
const netHandlers = {
  // ---- host side
  getWelcome() {
    const g = game; if (!g) return null;
    return {
      map: g.map.id,
      players: [{ id: 0, name: g.name }, ...[...g.net.clients.values()].map(c => ({ id: c.id, name: c.name }))],
      props: [...g.physics.props.values()].map(p => ({ id: p.id, key: p.key,
        p: [p.body.position.x, p.body.position.y, p.body.position.z],
        q: [p.body.quaternion.x, p.body.quaternion.y, p.body.quaternion.z, p.body.quaternion.w] })),
    };
  },
  onPlayerJoin(c) { const g = game; if (!g) return; g.names.set(c.id, c.name); g.remote.add(c.id, c.name); g.physics.addRemoteBody(c.id); ui.toast(`${c.name} joined`); updateCount(); },
  onPlayerLeave(c) { const g = game; if (!g) return; g.remote.remove(c.id); g.physics.removeRemoteBody(c.id); ui.toast(`${c.name} left`); updateCount(); },
  onClientState(c, m) {
    if (!game || !okVec(m.p) || !Number.isFinite(m.yaw) || !Number.isFinite(m.pitch)) return;
    game.remote.push(c.id, m, now());
  },
  onSpawnReq(c, m) {
    const g = game; if (!g || typeof m.key !== 'string' || !okVec(m.p) || !Number.isFinite(m.yaw)) return;
    if (!g.physics.spawnProp(m.key, m.p, m.yaw, { owner: c.id })) g.net.sendTo(c, { t: 'toast', msg: 'prop limit reached' });
  },
  onRemoveReq(c, m) { game?.physics.removeProp(m.id); },
  onClearReq() { game?.physics.clearProps(); },
  onDetReq(c, m) { game?.physics.detonate(m.id); },

  // ---- client side
  onSnap(m) {
    const g = game; if (!g || g.mode !== 'client') return;
    const t = now();
    for (const e of m.pl || []) {
      if (e[0] === g.myId) continue;
      if (!g.remote.map.has(e[0])) g.remote.add(e[0], g.names.get(e[0]) || 'player');
      g.remote.push(e[0], { p: [e[1], e[2], e[3]], yaw: e[4], pitch: e[5], an: e[6] }, t);
    }
    g.physics.applyPropStates(m.pr, t);
    updateCount();
  },
  onSpawned(m) {
    const g = game; if (!g || g.mode !== 'client') return;
    const p = g.physics.spawnProp(m.key, m.p, 0, { id: m.id, quat: m.q, owner: m.by, silent: true });
    if (!p) return;
    handleSpawnFx(p);
    if (m.by === g.myId) g.myProps.push(m.id);
  },
  onRemoved(m) { game?.physics.removeProp(m.id, true); },
  onCleared() { if (game) { game.physics.clearProps(); game.myProps.length = 0; } },
  onBoom(m) { if (game && okVec(m.p)) handleExplosion({ x: m.p[0], y: m.p[1], z: m.p[2] }, m.ex); },
  onJoin(m) { const g = game; if (!g) return; g.names.set(m.id, m.name); g.remote.add(m.id, m.name); ui.toast(`${m.name} joined`); updateCount(); },
  onLeave(m) { const g = game; if (!g) return; g.remote.remove(m.id); ui.toast(`${g.names.get(m.id) || 'player'} left`); updateCount(); },
  onToast(m) { ui.toast(String(m.msg)); },
  onDisconnect(reason) { if (!game) return; endSession(); ui.showTitle(reason); },
};

// ---------------------------------------------------------------- pointer lock, pause, input
function lock() {
  try {
    const p = canvas.requestPointerLock();
    if (p && p.catch) p.catch(() => ui.showLockHint(!!game && !game.paused));
  } catch (e) { ui.showLockHint(true); }
}
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  ui.showLockHint(!!game && !locked && !game.paused && !game.spawnHeld);
  // lost the lock without us asking (esc / alt-tab) -> pause menu
  if (game && !locked && !game.spawnHeld && !game.paused) pause();
});
document.addEventListener('pointerlockerror', () => { if (game && !game.paused) ui.showLockHint(true); });
canvas.addEventListener('click', () => { if (game && !game.paused && !locked && !game.spawnHeld) lock(); });

function pause() {
  if (!game || game.paused) return;
  game.paused = true; keys.clear();
  ui.showLockHint(false); ui.showPause(true, game.code);
}
function resume() {
  if (!game) return;
  game.paused = false; ui.showPause(false); lock();
}
function openSpawnMenu() {
  const g = game; if (!g || g.paused || g.player.dead) return;
  g.spawnHeld = true; ui.openSpawn(); document.exitPointerLock();
}
function closeSpawnMenu(relock = true) {
  const g = game; if (!g || !g.spawnHeld) return;
  g.spawnHeld = false; ui.closeSpawn();
  if (relock && !g.paused) lock();
}

addEventListener('keydown', e => {
  if (!game) return;
  if (game.paused) { if (e.code === 'Escape') resume(); return; }
  if (keyIs(e.code, 'help')) { e.preventDefault(); if (!e.repeat) ui.toggleHelp(); return; }
  if (!locked && !game.spawnHeld) return;
  if (['Space', 'Tab'].includes(e.code) || e.code.startsWith('Arrow')) e.preventDefault();
  if (e.repeat) return;
  keys.add(e.code);
  if (keyIs(e.code, 'spawnMenu') && locked) openSpawnMenu();
  else if (keyIs(e.code, 'remove')) removeAimed();
  else if (keyIs(e.code, 'undo')) undo();
  else if (keyIs(e.code, 'detonate')) detonateAimed();
  else if (keyIs(e.code, 'clearAll')) clearAll();
});
addEventListener('keyup', e => {
  keys.delete(e.code);
  if (game?.spawnHeld && keyIs(e.code, 'spawnMenu')) closeSpawnMenu();
});
addEventListener('blur', () => { keys.clear(); closeSpawnMenu(false); });
document.addEventListener('mousemove', e => {
  if (locked && game && !game.paused) game.player.look(e.movementX, e.movementY, 0.0022 * ui.settings.sens);
});
addEventListener('beforeunload', () => game?.net?.close());

// ---------------------------------------------------------------- ui wiring
ui.init({
  onStartSP(mapId) { startSession({ mode: 'sp', mapId }); lock(); },
  async onHost(mapId, name) {
    const net = new Net(netHandlers);
    try { const code = await net.host(name); startSession({ mode: 'host', mapId, net, name, code }); lock(); }
    catch (e) { net.close(); throw new Error(friendlyError(e)); }
  },
  async onJoin(code, name) {
    const net = new Net(netHandlers);
    try { const w = await net.join(code, name); startSession({ mode: 'client', mapId: w.map, net, name, code: code.toUpperCase(), welcome: w }); lock(); }
    catch (e) { net.close(); throw new Error(friendlyError(e)); }
  },
  onResume: resume,
  onExit() { endSession(); ui.showTitle(); },
  onSettings() { camera.fov = ui.settings.fov; camera.updateProjectionMatrix(); audio.setVolume(ui.settings.volume); },
  onSpawnItem(id) { requestSpawn(id); },
  onClearAll() { clearAll(); },
  onLockClick() { lock(); },
});
camera.fov = ui.settings.fov; camera.updateProjectionMatrix();

// ---------------------------------------------------------------- main loop
const clock = new THREE.Clock();
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (!game) return;
  update(dt);
  renderer.render(scene, camera);
}

function update(dt) {
  const g = game, t = now();
  const sim = !(g.paused && g.mode === 'sp');      // singleplayer pause freezes the world, multiplayer cannot
  if (sim) {
    g.player.update(dt, keys, locked && !g.paused);
    g.physics.step(dt);
    if (g.mode === 'client') g.physics.updateClient(t - NET.INTERP_DELAY);
    g.remote.update(dt, t - NET.INTERP_DELAY);
    if (g.mode === 'host') for (const [id, r] of g.remote.map) g.physics.moveRemoteBody(id, r.av.group.position, dt);
  }
  g.player.placeCamera(dt);
  g.effects.update(dt);
  if (g.effects.shake > 0) {                          // blast shake
    const s = g.effects.shake * 0.12;
    camera.position.x += (Math.random() - 0.5) * s; camera.position.y += (Math.random() - 0.5) * s;
  }
  audio.setListener(camera.position);

  // sun follows the player so shadows stay sharp
  const p = g.player.body.position;
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
      const me = g.player.netState();
      if (g.mode === 'host') {
        const pl = [[0, r3(me.p[0]), r3(me.p[1]), r3(me.p[2]), r3(me.yaw), r3(me.pitch), me.an]];
        for (const c of g.net.clients.values()) if (c.state) pl.push([c.id, r3(c.state.p[0]), r3(c.state.p[1]), r3(c.state.p[2]), r3(c.state.yaw), r3(c.state.pitch), String(c.state.an)]);
        g.net.broadcast({ t: 'snap', pl, pr: g.physics.collectDelta() });
      } else if (g.mode === 'client') {
        g.net.send({ t: 'st', p: me.p.map(r3), yaw: r3(me.yaw), pitch: r3(me.pitch), an: me.an });
        if (t - g.net.lastRecv > NET.HOST_TIMEOUT) netHandlers.onDisconnect('lost connection to the host');
      }
    }
  }
}

boot();
frame();
