// Everything the builder offers: tube bodies, wheel units, batteries, rotors and body panels.
// Plain data plus a few geometry helpers; Blueprint, Bodywork, the parts and GarageMenu all read it.

export const TUBE_MASS_PER_METRE = 3.5;              // kg of steel tube
export const TUBE_RADIUS = 0.035;                    // m, as drawn
export const RIDE_HEIGHT_RANGE = { min: 0.1, max: 0.7 }; // m of clearance under the frame
export const BARE_FRAME_DRAG = 0.95;                 // drag coefficient of an open tube frame
export const DRIVER_MASS = 80;                       // kg, robot or human
export const WHEEL_CLEARANCE = 0.05;                 // m between a frame tube and the inside of its tyre

// A body is a run of cross-section rings from nose (−Z) to tail (+Z). Each ring is a trapezoid:
// bottom and top heights above the frame bottom, and half widths at the bottom and top.
// Neighbouring rings are joined by four rails. The ranges name which ring-to-ring segments
// make up the hood, windshield, roof and rear deck, for the panels.
export const BODIES = {
  pod: {
    name: 'Pod',
    blurb: 'Tiny upright city box. Light, cheap and nimble.',
    rings: [
      { z: -1.45, bottom: 0.06, top: 0.72, bottomHalfWidth: 0.66, topHalfWidth: 0.64 },
      { z: -1.2, bottom: 0, top: 0.78, bottomHalfWidth: 0.7, topHalfWidth: 0.66 },
      { z: -0.8, bottom: 0, top: 1.45, bottomHalfWidth: 0.7, topHalfWidth: 0.62 },
      { z: 1.3, bottom: 0, top: 1.5, bottomHalfWidth: 0.7, topHalfWidth: 0.63 },
      { z: 1.45, bottom: 0.05, top: 1.45, bottomHalfWidth: 0.68, topHalfWidth: 0.62 },
    ],
    hood: [0, 1], windshield: [1, 2], roof: [2, 3], deck: [3, 4],
    seat: [0, 0, -0.1],
    floorMass: 60,
  },
  trekker: {
    name: 'Trekker',
    blurb: 'Long, wide and tall. Built for rough country.',
    rings: [
      { z: -2.3, bottom: 0.12, top: 0.75, bottomHalfWidth: 0.92, topHalfWidth: 0.88 },
      { z: -1.7, bottom: 0, top: 0.95, bottomHalfWidth: 0.98, topHalfWidth: 0.95 },
      { z: -0.7, bottom: 0, top: 1.0, bottomHalfWidth: 0.98, topHalfWidth: 0.95 },
      { z: -0.1, bottom: 0, top: 1.6, bottomHalfWidth: 0.98, topHalfWidth: 0.82 },
      { z: 1.5, bottom: 0, top: 1.62, bottomHalfWidth: 0.98, topHalfWidth: 0.84 },
      { z: 2.3, bottom: 0.12, top: 1.1, bottomHalfWidth: 0.94, topHalfWidth: 0.9 },
    ],
    hood: [0, 2], windshield: [2, 3], roof: [3, 4], deck: [4, 5],
    seat: [0, 0, 0.35],
    floorMass: 120,
  },
  runner: {
    name: 'Runner',
    blurb: 'Low wedge for speed on smooth rock. Hates being airborne.',
    rings: [
      { z: -2.0, bottom: 0.04, top: 0.32, bottomHalfWidth: 0.84, topHalfWidth: 0.8 },
      { z: -1.2, bottom: 0, top: 0.55, bottomHalfWidth: 0.9, topHalfWidth: 0.86 },
      { z: -0.35, bottom: 0, top: 0.7, bottomHalfWidth: 0.9, topHalfWidth: 0.84 },
      { z: 0.15, bottom: 0, top: 1.1, bottomHalfWidth: 0.9, topHalfWidth: 0.66 },
      { z: 1.1, bottom: 0, top: 1.05, bottomHalfWidth: 0.9, topHalfWidth: 0.68 },
      { z: 1.95, bottom: 0.05, top: 0.72, bottomHalfWidth: 0.88, topHalfWidth: 0.84 },
    ],
    hood: [0, 2], windshield: [2, 3], roof: [3, 4], deck: [4, 5],
    seat: [0, 0, 0.5],
    floorMass: 80,
  },
};

// Every wheel unit comes with its suspension, hub motor and axle. Motor torque is at the wheel (N·m),
// power in watts; looseGrip multiplies grip on sand and mud.
export const WHEELS = {
  city: {
    name: 'City wheel', blurb: 'Small and light. Fine on rock and road, weak off them.',
    radius: 0.3, width: 0.17, mass: 16, grip: 1.0, looseGrip: 0.75, motorTorque: 170, motorPower: 12000, maxSpeed: 30,
  },
  slick: {
    name: 'Road slick', blurb: 'Huge grip on rock, hopeless in mud.',
    radius: 0.35, width: 0.28, mass: 22, grip: 1.3, looseGrip: 0.6, motorTorque: 340, motorPower: 38000, maxSpeed: 52,
  },
  allTerrain: {
    name: 'All-terrain', blurb: 'The sensible choice.',
    radius: 0.42, width: 0.3, mass: 30, grip: 1.12, looseGrip: 0.95, motorTorque: 480, motorPower: 32000, maxSpeed: 42,
  },
  knobby: {
    name: 'Big knobby', blurb: 'Climbs anything. Heavy, and slow to change direction.',
    radius: 0.56, width: 0.4, mass: 46, grip: 1.05, looseGrip: 1.15, motorTorque: 780, motorPower: 42000, maxSpeed: 36,
  },
};

// Capacity in watt-hours, power in watts, size in metres (x, y, z).
export const BATTERIES = {
  cell: {
    name: 'Cell pack', blurb: 'Small and light; tuck it anywhere.',
    size: [0.42, 0.2, 0.36], mass: 38, capacity: 1500, maxPower: 24000,
  },
  slab: {
    name: 'Slab pack', blurb: 'Big flat pack: lots of power and range, lots of weight.',
    size: [0.9, 0.16, 0.7], mass: 130, capacity: 6000, maxPower: 70000,
  },
};

export const ROTORS = {
  small: {
    name: 'Small rotor', blurb: 'Light. Four of them lift a light build.',
    bladeRadius: 0.6, armLength: 0.75, maxThrust: 2600, mass: 12,
  },
  large: {
    name: 'Large rotor', blurb: 'Lifts heavy builds, but heavy itself.',
    bladeRadius: 0.85, armLength: 1.05, maxThrust: 4600, mass: 22,
  },
};

// Body panels sit in fixed slots. drag adds to the drag coefficient (covering the frame lowers it);
// downforce is lift area in m² (C × A), pushing down at the slot as speed squared.
export const PANEL_SLOTS = {
  nose: {
    name: 'Nose',
    styles: {
      none: { name: 'Open frame', mass: 0, drag: 0, downforce: 0 },
      panel: { name: 'Panel', mass: 8, drag: -0.12, downforce: 0 },
      grille: { name: 'Grille', mass: 10, drag: -0.08, downforce: 0 },
      splitter: { name: 'Splitter', mass: 12, drag: -0.1, downforce: 0.25 },
    },
  },
  hood: {
    name: 'Hood',
    styles: {
      none: { name: 'Open frame', mass: 0, drag: 0, downforce: 0 },
      panel: { name: 'Panel', mass: 6, drag: -0.05, downforce: 0 },
      vented: { name: 'Vented', mass: 7, drag: -0.03, downforce: 0 },
    },
  },
  roof: {
    name: 'Roof and glass',
    styles: {
      none: { name: 'Open cockpit', mass: 0, drag: 0, downforce: 0 },
      panel: { name: 'Windshield and roof', mass: 12, drag: -0.1, downforce: 0 },
      glass: { name: 'Glass canopy', mass: 14, drag: -0.1, downforce: 0 },
    },
  },
  sides: {
    name: 'Sides',
    styles: {
      none: { name: 'Open frame', mass: 0, drag: 0, downforce: 0 },
      skirts: { name: 'Skirts', mass: 8, drag: -0.04, downforce: 0.15 },
      panels: { name: 'Panels', mass: 16, drag: -0.1, downforce: 0 },
      doors: { name: 'Doors and windows', mass: 20, drag: -0.11, downforce: 0 },
    },
  },
  tail: {
    name: 'Tail',
    styles: {
      none: { name: 'Open frame', mass: 0, drag: 0, downforce: 0 },
      panel: { name: 'Panel', mass: 6, drag: -0.06, downforce: 0 },
      ducktail: { name: 'Ducktail', mass: 8, drag: -0.05, downforce: 0.2 },
    },
  },
  wing: {
    name: 'Wing',
    styles: {
      none: { name: 'None', mass: 0, drag: 0, downforce: 0 },
      low: { name: 'Low wing', mass: 9, drag: 0.03, downforce: 0.45 },
      high: { name: 'High wing', mass: 11, drag: 0.06, downforce: 0.8 },
    },
  },
};

export const PAINTS = ['#e2582c', '#3f8f8a', '#f2d14b', '#7fd6c4', '#d94f6a', '#4f6fd9', '#e8e4d8', '#3a3f44'];

/** Every tube of a body's frame as { start, end } points [x, y, z]: ring edges, then rails between rings. */
export function frameTubes(body) {
  const tubes = [];
  body.rings.forEach((ring, index) => {
    const here = ringCorners(ring);
    tubes.push([here.bottomLeft, here.bottomRight], [here.topLeft, here.topRight]);
    tubes.push([here.bottomLeft, here.topLeft], [here.bottomRight, here.topRight]);
    if (index === 0) return;
    const before = ringCorners(body.rings[index - 1]);
    tubes.push([before.bottomLeft, here.bottomLeft], [before.bottomRight, here.bottomRight]);
    tubes.push([before.topLeft, here.topLeft], [before.topRight, here.topRight]);
  });
  return tubes.map(([start, end]) => ({ start, end }));
}

/** The four corners of a ring as [x, y, z]. */
export function ringCorners(ring) {
  return {
    bottomLeft: [-ring.bottomHalfWidth, ring.bottom, ring.z],
    bottomRight: [ring.bottomHalfWidth, ring.bottom, ring.z],
    topLeft: [-ring.topHalfWidth, ring.top, ring.z],
    topRight: [ring.topHalfWidth, ring.top, ring.z],
  };
}

/** A point on a side rail between two neighbouring rings: level 'bottom' or 'top', side −1 left / +1 right, t 0..1. */
export function railPoint(body, fromRing, toRing, level, side, t) {
  const from = body.rings[fromRing];
  const to = body.rings[toRing];
  const halfWidth = ring => (level === 'top' ? ring.topHalfWidth : ring.bottomHalfWidth);
  const height = ring => (level === 'top' ? ring.top : ring.bottom);
  return [
    side * lerp(halfWidth(from), halfWidth(to), t),
    lerp(height(from), height(to), t),
    lerp(from.z, to.z, t),
  ];
}

/** Overall width, height and length of a body's frame, in metres. */
export function bodySize(body) {
  const rings = body.rings;
  return {
    width: 2 * Math.max(...rings.map(ring => Math.max(ring.bottomHalfWidth, ring.topHalfWidth))),
    height: Math.max(...rings.map(ring => ring.top)),
    length: rings.at(-1).z - rings[0].z,
  };
}

/** Where each panel slot sits on a body, for its mass and its downforce. */
export function slotAnchor(body, slot) {
  const first = body.rings[0];
  const last = body.rings.at(-1);
  const topCentre = ([from, to]) => {
    const rings = body.rings.slice(from, to + 1);
    return [0, average(rings.map(ring => ring.top)), average(rings.map(ring => ring.z))];
  };
  const anchors = {
    nose: () => [0, first.bottom, first.z],
    hood: () => topCentre(body.hood),
    roof: () => topCentre(body.roof),
    sides: () => [0, average(body.rings.map(ring => ring.top)) / 2, (first.z + last.z) / 2],
    tail: () => [0, last.top, last.z],
    wing: () => [0, last.top + 0.35, last.z - 0.15],
  };
  return anchors[slot]();
}

/** Static hub centre of a wheel mounted at `mount` (chassis-local), with the frame bottom rideHeight off the ground. */
export function wheelHubPosition(model, mount, rideHeight) {
  const side = Math.sign(mount[0]);
  return [mount[0] + side * (model.width / 2 + WHEEL_CLEARANCE), model.radius - rideHeight, mount[2]];
}

/** Direction a rotor's arm swings out to: away from the centre of the frame, front-to-back weighted less. */
export function rotorOutward(pivot) {
  const x = Math.sign(pivot[0]);
  const z = Math.sign(pivot[2]) * 0.8;
  const length = Math.hypot(x, z) || 1;
  return x === 0 && z === 0 ? [1, 0, 0] : [x / length, 0, z / length];
}

/** Hub of a rotor at the end of its swung-out arm. */
export function rotorHubPosition(model, pivot) {
  const outward = rotorOutward(pivot);
  return [pivot[0] + outward[0] * model.armLength, pivot[1], pivot[2] + outward[2] * model.armLength];
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
