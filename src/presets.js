import { BODIES, railPoint } from './catalog.js';

// Starter designs as Blueprint JSON. Wheel and rotor mounts come from the body rails so they sit on real tubes;
// batteries sit on the floor pan (its top is 0.015 m up, so a pack's centre is that plus half its height).

const trekker = BODIES.trekker;
const pod = BODIES.pod;
const runner = BODIES.runner;
const LEFT = -1;

export const PRESETS = {
  trekker: {
    name: 'Trekker test rig',
    body: 'trekker',
    rideHeight: 0.38,
    paint: '#e2582c',
    panels: { nose: 'grille', hood: 'vented', roof: 'panel', sides: 'doors', tail: 'panel', wing: 'none' },
    mounts: [
      { part: 'wheel', model: 'allTerrain', position: railPoint(trekker, 1, 2, 'bottom', LEFT, 0.15), mirror: true },
      { part: 'wheel', model: 'allTerrain', position: railPoint(trekker, 4, 5, 'bottom', LEFT, 0.05), mirror: true },
      { part: 'battery', model: 'slab', position: [0, 0.095, -0.75], mirror: false },
      { part: 'battery', model: 'slab', position: [0, 0.095, 0.55], mirror: false },
      { part: 'rotor', model: 'large', position: railPoint(trekker, 1, 2, 'top', LEFT, 0.25), mirror: true },
      { part: 'rotor', model: 'large', position: railPoint(trekker, 4, 5, 'top', LEFT, 0.5), mirror: true },
    ],
  },
  pod: {
    name: 'City pod',
    body: 'pod',
    rideHeight: 0.18,
    paint: '#7fd6c4',
    panels: { nose: 'panel', hood: 'panel', roof: 'panel', sides: 'doors', tail: 'panel', wing: 'none' },
    mounts: [
      { part: 'wheel', model: 'city', position: railPoint(pod, 1, 2, 'bottom', LEFT, 0.2), mirror: true },
      { part: 'wheel', model: 'city', position: railPoint(pod, 3, 4, 'bottom', LEFT, 0), mirror: true },
      { part: 'battery', model: 'cell', position: [-0.3, 0.115, 0.3], mirror: true },
    ],
  },
  runner: {
    name: 'Rock runner',
    body: 'runner',
    rideHeight: 0.12,
    paint: '#f2d14b',
    panels: { nose: 'splitter', hood: 'panel', roof: 'glass', sides: 'panels', tail: 'ducktail', wing: 'low' },
    mounts: [
      { part: 'wheel', model: 'slick', position: railPoint(runner, 0, 1, 'bottom', LEFT, 0.6), mirror: true },
      { part: 'wheel', model: 'slick', position: railPoint(runner, 4, 5, 'bottom', LEFT, 0.35), mirror: true },
      { part: 'battery', model: 'slab', position: [0, 0.095, -0.3], mirror: false },
      { part: 'battery', model: 'cell', position: [-0.45, 0.115, 0.75], mirror: true },
    ],
  },
};

export const DEFAULT_PRESET = 'trekker';
