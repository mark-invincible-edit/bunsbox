// spawnables.js - THE spawn list. add an entry here and it shows up in the menu, nothing else to touch.
//
// id        unique, never rename it once people play together (it is sent over the network)
// name      label in the menu
// category  any string, new categories appear as new tabs automatically
// glb       path inside /assets (models go in assets/models/). missing file = colored placeholder box
// scale     uniform scale applied to the model (the model is auto-centered on its bounding box)
// shape     'box' (size = HALF extents [x,y,z] in meters) or 'sphere' (size = [radius])
// mass      kg
// color     placeholder color
// bouncy    optional, true = high restitution
// explosive optional { radius, force, damage, fuse?, impact? }
//             force  = peak speed (m/s) given to things at the center
//             fuse   = seconds until it blows by itself
//             impact = blows when it hits something faster than this (m/s)
// seat      optional, true = press E to sit on it (needs to be upright)
// thruster  optional { thrust, dir } press E to toggle. thrust = newtons, dir = local direction it pushes
//             [0,0,-1] = forward (the way you faced when you spawned it), [0,1,0] = up
// item      optional, an id from ITEMS in items.js. pressing E picks it up into your inventory.
//             items ignore glb/scale here: their model + size come from items.js (auto-fitted)
//
// note: 'size' is the physics collider in world units, 'scale' only scales the model.
// if you scale a model, scale 'size' by hand to match.
export const SPAWNABLES = [
  // ---- props ----
  { id: 'crate', name: 'Crate', category: 'Props', glb: 'models/crate.glb', scale: 0.015, shape: 'box', size: [0.5, 0.5, 0.5], mass: 15, color: 0xb07a3c },
  { id: 'big_crate', name: 'Big Crate', category: 'Props', glb: 'models/crate.glb', scale: 0.034, shape: 'box', size: [1, 1, 1], mass: 120, color: 0xa06a30 },
  { id: 'barrel', name: 'Barrel', category: 'Props', glb: 'models/barrel.glb', scale: 0.03, shape: 'box', size: [0.3, 0.45, 0.3], mass: 25, color: 0x3f6fb0 },
  { id: 'table', name: 'Table', category: 'Props', glb: 'models/table.glb', scale: 0.3, shape: 'box', size: [0.7, 0.4, 0.45], mass: 20, color: 0x8b5a2b },
  { id: 'chair', name: 'Chair', category: 'Props', glb: 'models/chair.glb', scale: 0.13, shape: 'box', size: [0.25, 0.45, 0.25], mass: 6, color: 0x7a4e24, seat: true },
  { id: 'cone', name: 'Traffic Cone', category: 'Props', glb: 'models/traffic_cone.glb', scale: 0.04, shape: 'box', size: [0.17, 0.65, 0.17], mass: 2, color: 0xff7a1a },
  { id: 'thruster', name: 'Thruster (forward)', category: 'Props', glb: 'models/thruster.glb', scale: 1, shape: 'box', size: [0.2, 0.2, 0.3], mass: 5, color: 0x4a90d9, thruster: { thrust: 900, dir: [0, 0, -1] } },
  { id: 'thruster_up', name: 'Thruster (up)', category: 'Props', glb: 'models/thruster.glb', scale: 1, shape: 'box', size: [0.2, 0.2, 0.3], mass: 5, color: 0x4a90d9, thruster: { thrust: 900, dir: [0, 1, 0] } },

  // ---- physics objects ----
  { id: 'ball', name: 'Ball', category: 'Physics Objects', glb: 'models/ball.glb', scale: 0.4, shape: 'sphere', size: [0.35], mass: 3, color: 0xe04040, bouncy: true },
  { id: 'big_ball', name: 'Big Ball', category: 'Physics Objects', glb: 'models/ball.glb', scale: 1, shape: 'sphere', size: [1.05], mass: 30, color: 0x40a0e0, bouncy: true },
  { id: 'heavy_cube', name: 'Heavy Cube', category: 'Physics Objects', glb: 'models/crate.glb', scale: 0.02, shape: 'box', size: [0.75, 0.75, 0.75], mass: 400, color: 0x555555 },

  // ---- explosives ----
  { id: 'explosive_barrel', name: 'Explosive Barrel', category: 'Explosives', glb: 'models/explosive_barrel.glb', scale: 0.4, shape: 'box', size: [0.3, 0.7, 0.3], mass: 25, color: 0xcc2b2b, explosive: { radius: 10, force: 20, damage: 80, impact: 12 } },
  { id: 'mega_barrel', name: 'Mega Barrel', category: 'Explosives', glb: 'models/explosive_barrel.glb', scale: 0.6, shape: 'box', size: [0.6, 0.9, 0.6], mass: 80, color: 0x991010, explosive: { radius: 24, force: 34, damage: 140, impact: 12 } },
  { id: 'timed_bomb', name: 'Timed Bomb (4s)', category: 'Explosives', glb: 'models/bomb.glb', scale: 3, shape: 'sphere', size: [0.3], mass: 8, color: 0x222222, explosive: { radius: 12, force: 24, damage: 90, fuse: 4 } },
  { id: 'grenade', name: 'Impact Grenade', category: 'Explosives', glb: 'models/grenade.glb', scale: 0.6, shape: 'sphere', size: [0.12], mass: 1, color: 0x4a6b2a, explosive: { radius: 6, force: 14, damage: 60, impact: 6 } },

  // ---- animals / npcs (physics props, no ai) ----
  { id: 'pigeon', name: 'Pigeon', category: 'Animals/NPCs', glb: 'models/pigeon.glb', scale: 1, shape: 'box', size: [0.18, 0.14, 0.28], mass: 1, color: 0x9aa3ad },
  { id: 'big_pigeon', name: 'Big Pigeon', category: 'Animals/NPCs', glb: 'models/pigeon.glb', scale: 4, shape: 'box', size: [0.72, 0.56, 1.12], mass: 40, color: 0x9aa3ad },

  // ---- items (press E on one lying on the ground to pick it up, scroll to switch) ----
  // the collider lies flat along x. model/size/scale of the held version live in items.js
  { id: 'item_crowbar', name: 'Crowbar', category: 'Items', shape: 'box', size: [0.35, 0.04, 0.04], mass: 2, color: 0xc0392b, item: 'crowbar' },
  { id: 'item_physgun', name: 'Physics Gun', category: 'Items', shape: 'box', size: [0.25, 0.07, 0.07], mass: 3, color: 0xd0d4da, item: 'physgun' },
  { id: 'item_glue', name: 'Glue', category: 'Items', shape: 'box', size: [0.14, 0.05, 0.05], mass: 0.5, color: 0xf5f5f5, item: 'glue' },
];

const byId = new Map();
for (const s of SPAWNABLES) {
  if (byId.has(s.id)) console.warn(`[spawnables] duplicate id: ${s.id}`);
  byId.set(s.id, s);
}
export const getSpawnable = id => byId.get(id);
export const CATEGORIES = [...new Set(SPAWNABLES.map(s => s.category))];
