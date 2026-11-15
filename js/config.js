// config.js - everything you might want to tweak lives here.

// keybinds are KeyboardEvent.code values. the spawn menu is HELD, not toggled.
export const KEYS = {
  forward: ['KeyW'], back: ['KeyS'], left: ['KeyA'], right: ['KeyD'],
  jump: ['Space'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  spawnMenu: ['KeyQ'],          // <- change the spawn menu key here
  remove: ['KeyX'],             // remove the prop you are aiming at
  undo: ['KeyZ'],               // remove your last spawned prop
  detonate: ['KeyF'],           // detonate the explosive you are aiming at
  clearAll: ['KeyC'],           // remove every prop
  help: ['KeyH', 'F1'],
};
export const keyIs = (code, action) => KEYS[action].includes(code);
export const keyHeld = (set, action) => KEYS[action].some(c => set.has(c));

export const PLAYER = {
  HEIGHT: 1.8, EYE: 1.62,
  WALK: 4.6, SPRINT: 7.8, BACK_MULT: 0.7,
  JUMP: 7.0, GRAVITY: -22,
  MAX_HP: 100, RESPAWN_DELAY: 4,
  FALL_SAFE: 15,      // landing speed (m/s) that hurts nothing
  FALL_DMG: 7,        // damage per m/s above the safe speed
  MODEL_YAW_OFFSET: Math.PI,   // if remote players face backwards, set this to 0
  STRIP_ROOT_MOTION: true,     // drops hips position tracks so mixamo clips do not drift
};

export const NET = {
  TICK_RATE: 20,            // snapshots per second
  INTERP_DELAY: 0.12,       // seconds of interpolation delay on clients
  ROOM_PREFIX: 'bunsbox-',  // peerjs id prefix (room code is appended)
  MAX_PLAYERS: 8,
  CONNECT_TIMEOUT: 12000,   // ms
  HOST_TIMEOUT: 10,         // seconds without host data before clients give up
  // stun only. strict nats need a turn server: add one here, e.g.
  // { urls: 'turn:your.server:3478', username: 'u', credential: 'p' }
  ICE_SERVERS: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

export const GROUPS = { WORLD: 1, PLAYER: 2, PROP: 4, REMOTE: 8 };
export const LIMITS = { MAX_PROPS: 150, REACH: 60 };

// clip names inside plr.glb -> state names
export const ANIMS = {
  idle: 'mixamo.com',
  walk: 'walking very fast',
  left: 'Left Strafe Walking',
  right: 'Right Strafe Walking',
  back: 'Walking Backwards',
  run: 'Runnin',
  jump: 'Jumping',
  fall: 'Falling Idle (1)',
  knockback: 'Falling',
  dead: 'deaaaaaaaad',
};
export const ONE_SHOT = ['jump', 'dead'];   // play once and hold the last frame

export const PLAYER_MODEL = 'plr.glb';
export const TEXTURE_FILES = [
  'concreteground.png', 'concretewall.png', 'grassground.png', 'metalplates.png',
  'rockyground.png', 'rustymetal.png', 'woodplanks.png',
];
export const SOUND_NAMES = [
  'footstep_grass', 'footstep_concrete', 'footstep_metal', 'footstep_rock', 'footstep_wood',
  'jump', 'land', 'spawn', 'explosion', 'click', 'wind',
];
