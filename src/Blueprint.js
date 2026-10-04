import * as THREE from 'three';
import {
  BODIES, WHEELS, BATTERIES, BOOSTERS, ROTORS, BALLASTS, GYROS, PANEL_SLOTS, PAINTS, RIDE_HEIGHT_RANGE,
  TUBE_MASS_PER_METRE, BARE_FRAME_DRAG, DRIVER_MASS,
  frameTubes, bodySize, slotAnchor, wheelHubPosition, rotorHubPosition,
} from './catalog.js';
import { rotorPower, rotorTuning } from './Rotor.js';
import { balancedShares } from './balance.js';

const MODELS = { wheel: WHEELS, battery: BATTERIES, surge: BOOSTERS, rotor: ROTORS, ballast: BALLASTS, gyro: GYROS };
const BOX_PARTS = ['battery', 'surge', 'ballast', 'gyro']; // solid boxes that must not overlap each other
const DEFAULT_PANELS = { nose: 'panel', hood: 'panel', roof: 'panel', sides: 'doors', tail: 'panel', wing: 'none' };
const MIRROR_EPSILON = 0.05;     // m; mounts this close to the centre line get no mirror twin
const GRAVITY = 9.81;
const AIR_DENSITY = 1.2;
const ROLLING_RESISTANCE = 0.02;
const DRIVE_EFFICIENCY = 0.9;
const CRUISE_SPEED = 60 / 3.6;   // m/s, for the range estimate
const MIN_DRAG_COEFFICIENT = 0.25;
const DRIVER_HEIGHT = 0.6;       // m above the floor, for the driver's mass
const PART_GAP = 0.02;           // m two batteries must keep between them

const ALIGNMENT_RANGE = { toe: 3, camber: 4 };  // degrees, either side of straight
const ALIGNMENT_DEFAULTS = { frontToe: 0, frontCamber: 0, rearToe: 0, rearCamber: 0 };

// The handling dials a design carries. torqueSplit: share of motor torque asked of the rear axle (0.5 = even).
// brakeBias: share of braking asked of the front. springRate and antiRoll multiply the auto-tuned values.
// regen: fraction of braking energy the batteries take back.
export const TUNING_DEFAULTS = { torqueSplit: 0.5, springRate: 1, antiRoll: 1, brakeBias: 0.55, regen: 0.35 };
// Control setups: how much help the vehicle gives. drive 'simple' smooths the pedals, cuts wheelspin
// and leans harder on the stability assists; flight 'acro' turns the rotors into a rate-controlled
// trick quad (no self-levelling, no height hold). Default: advanced driving, assisted hovering.
export const CONTROL_MODES = { drive: ['advanced', 'simple'], flight: ['assist', 'acro'] };
export const CONTROL_DEFAULTS = { drive: 'advanced', flight: 'assist' };
export const TUNING_RANGES = {
  torqueSplit: [0.2, 0.8],
  springRate: [0.7, 1.5],
  antiRoll: [0, 2],
  brakeBias: [0.35, 0.7],
  regen: [0, 0.9],
};

/**
 * Blueprint: a vehicle design. A tube body, the parts mounted on it (mirrored left to right when asked),
 * body panels, wheel alignment, ride height and paint. Works out what the design weighs, where its centre
 * of mass sits, how its weight spreads over the wheels, its headline stats and what's wrong with it.
 * Garage and GarageMenu edit it; Vehicle, Chassis and Bodywork are built from it. Saves as plain JSON.
 */
export class Blueprint {
  name = 'Unnamed';
  bodyKey = 'trekker';
  rideHeight = 0.35;
  paint = PAINTS[0];
  panels = { ...DEFAULT_PANELS };
  alignment = { ...ALIGNMENT_DEFAULTS }; // degrees: toe-in and camber (tops inward), front and rear
  tuning = { ...TUNING_DEFAULTS };       // the handling dials; see TUNING_DEFAULTS
  controls = { ...CONTROL_DEFAULTS };    // control setups: see CONTROL_MODES
  mounts = [];                 // [{ id, part, model, position: [x, y, z], mirror }]
  adjustableRideHeight = true; // the test vehicle's privilege; later an upgrade
  nextMountId = 1;

  constructor(data = {}) {
    if (typeof data.name === 'string') this.name = data.name;
    if (BODIES[data.body]) this.bodyKey = data.body;
    if (typeof data.rideHeight === 'number') this.setRideHeight(data.rideHeight);
    if (typeof data.paint === 'string') this.paint = data.paint;
    if (typeof data.adjustableRideHeight === 'boolean') this.adjustableRideHeight = data.adjustableRideHeight;
    for (const [slot, style] of Object.entries(data.panels ?? {})) this.setPanel(slot, style);
    for (const [key, degrees] of Object.entries(data.alignment ?? {})) this.setAlignment(key, degrees);
    for (const [key, value] of Object.entries(data.tuning ?? {})) this.setTuning(key, value);
    for (const [key, mode] of Object.entries(data.controls ?? {})) this.setControls(key, mode);
    for (const mount of data.mounts ?? []) {
      if (MODELS[mount.part]?.[mount.model] && Array.isArray(mount.position)) {
        this.addMount(mount.part, mount.model, mount.position, Boolean(mount.mirror));
      }
    }
  }

  static fromJSON(json) {
    return new Blueprint(typeof json === 'string' ? JSON.parse(json) : json);
  }

  toJSON() {
    return {
      version: 1,
      name: this.name,
      body: this.bodyKey,
      rideHeight: this.rideHeight,
      paint: this.paint,
      adjustableRideHeight: this.adjustableRideHeight,
      panels: { ...this.panels },
      alignment: { ...this.alignment },
      tuning: { ...this.tuning },
      controls: { ...this.controls },
      mounts: this.mounts.map(({ part, model, position, mirror }) => ({ part, model, position: [...position], mirror })),
    };
  }

  clone() {
    return Blueprint.fromJSON(this.toJSON());
  }

  body() { return BODIES[this.bodyKey]; }
  frameTubes() { return frameTubes(this.body()); }

  setName(name) { this.name = name.trim() || 'Unnamed'; }
  setPaint(paint) { this.paint = paint; }

  setRideHeight(height) {
    this.rideHeight = THREE.MathUtils.clamp(height, RIDE_HEIGHT_RANGE.min, RIDE_HEIGHT_RANGE.max);
  }

  setPanel(slot, style) {
    if (PANEL_SLOTS[slot]?.styles[style]) this.panels[slot] = style;
  }

  /** Sets one alignment angle in degrees: frontToe, frontCamber, rearToe or rearCamber. */
  setAlignment(key, degrees) {
    const limit = key.endsWith('Toe') ? ALIGNMENT_RANGE.toe : ALIGNMENT_RANGE.camber;
    if (key in this.alignment) this.alignment[key] = THREE.MathUtils.clamp(degrees, -limit, limit);
  }

  /** Sets one handling dial: torqueSplit, springRate, antiRoll, brakeBias or regen. */
  setTuning(key, value) {
    const range = TUNING_RANGES[key];
    if (range) this.tuning[key] = THREE.MathUtils.clamp(value, range[0], range[1]);
  }

  /** Sets a control setup: drive 'advanced'|'simple', flight 'assist'|'acro'. */
  setControls(key, mode) {
    if (CONTROL_MODES[key]?.includes(mode)) this.controls[key] = mode;
  }

  /** Switches to another tube body. Mount points belong to the old frame, so the parts come off. */
  setBody(bodyKey) {
    if (!BODIES[bodyKey]) return;
    this.bodyKey = bodyKey;
    this.mounts = [];
  }

  /** Mounts a part (and its mirror twin) and returns the mount's id. */
  addMount(part, model, position, mirror) {
    const id = this.nextMountId++;
    this.mounts.push({ id, part, model, position: position.map(value => round(value)), mirror });
    return id;
  }

  /** Takes a mount, and its mirror twin, off the design. */
  removeMount(id) {
    this.mounts = this.mounts.filter(mount => mount.id !== id);
  }

  /** Every part as it sits on the vehicle, mirror twins included: { mountId, part, modelKey, model, position }. */
  placedParts() {
    const placed = [];
    for (const mount of this.mounts) {
      placed.push(this.placement(mount, mount.position));
      if (mount.mirror && Math.abs(mount.position[0]) > MIRROR_EPSILON) {
        placed.push(this.placement(mount, [-mount.position[0], mount.position[1], mount.position[2]]));
      }
    }
    return placed;
  }

  /** Why a part can't go here (a short sentence), or null if it can. */
  canPlace(part, modelKey, position, mirror) {
    const model = MODELS[part][modelKey];
    const candidates = [position];
    if (mirror && Math.abs(position[0]) > MIRROR_EPSILON) candidates.push([-position[0], position[1], position[2]]);
    const placed = this.placedParts();
    const existing = placed.filter(item => item.part === part);
    const boxes = placed.filter(item => BOX_PARTS.includes(item.part));
    const checks = {
      battery: () => boxClash(model, candidates, boxes, 'part'),
      surge: () => boxClash(model, candidates, boxes, 'part'),
      ballast: () => boxClash(model, candidates, boxes, 'part'),
      gyro: () => boxClash(model, candidates, boxes, 'part'),
      wheel: () => wheelClash(model, candidates, existing, this.rideHeight),
      rotor: () => rotorClash(model, candidates, existing),
    };
    return checks[part]();
  }

  /** Total mass (kg), centre of mass and rotational inertia (about the centre of mass, chassis axes). */
  massProperties() {
    const items = this.massItems();
    const mass = items.reduce((sum, item) => sum + item.mass, 0);
    const centerOfMass = new THREE.Vector3();
    for (const item of items) centerOfMass.addScaledVector(new THREE.Vector3(...item.position), item.mass / mass);
    const inertia = new THREE.Vector3();
    for (const { mass: itemMass, position } of items) {
      const [x, y, z] = [position[0] - centerOfMass.x, position[1] - centerOfMass.y, position[2] - centerOfMass.z];
      inertia.x += itemMass * (y * y + z * z);
      inertia.y += itemMass * (x * x + z * z);
      inertia.z += itemMass * (x * x + y * y);
    }
    return { mass, centerOfMass, inertia };
  }

  /** The weight (N) each wheel carries at rest, in placedParts() order, balanced so the vehicle sits level. */
  wheelLoads() {
    const { mass, centerOfMass } = this.massProperties();
    const hubs = this.placedParts()
      .filter(placed => placed.part === 'wheel')
      .map(placed => wheelHubPosition(placed.model, placed.position, this.rideHeight));
    return balancedShares(hubs.map(([x, , z]) => [x, z]), centerOfMass.x, centerOfMass.z, mass * GRAVITY);
  }

  /** Drag coefficient × frontal area (m²): an open frame is draggy; panels smooth it, wings add some back. */
  dragArea() {
    const size = bodySize(this.body());
    const coefficient = Object.entries(this.panels)
      .reduce((sum, [slot, style]) => sum + PANEL_SLOTS[slot].styles[style].drag, BARE_FRAME_DRAG);
    const frontalArea = size.width * (size.height + this.rideHeight * 0.5) * 0.85;
    return Math.max(coefficient, MIN_DRAG_COEFFICIENT) * frontalArea;
  }

  /** Panels that press the vehicle down at speed: [{ position: [x, y, z], area }]. */
  downforceSurfaces() {
    return Object.entries(this.panels)
      .map(([slot, style]) => ({ slot, area: PANEL_SLOTS[slot].styles[style].downforce }))
      .filter(surface => surface.area > 0)
      .map(surface => ({ position: slotAnchor(this.body(), surface.slot), area: surface.area }));
  }

  /** Headline numbers for the garage. */
  stats() {
    const { mass, centerOfMass } = this.massProperties();
    const weight = mass * GRAVITY;
    const placed = this.placedParts();
    const wheels = placed.filter(item => item.part === 'wheel');
    const batteries = placed.filter(item => item.part === 'battery');
    const rotors = placed.filter(item => item.part === 'rotor');
    const surges = placed.filter(item => item.part === 'surge');
    const gyros = placed.filter(item => item.part === 'gyro');
    const sum = (items, key) => items.reduce((total, item) => total + item.model[key], 0);

    const wheelPower = sum(wheels, 'motorPower');
    const batteryPower = sum(batteries, 'maxPower');
    const capacity = sum(batteries, 'capacity');
    const usablePower = Math.min(wheelPower, batteryPower) * DRIVE_EFFICIENCY;
    const dragArea = this.dragArea();
    const resistancePower = speed => (0.5 * AIR_DENSITY * dragArea * speed * speed + ROLLING_RESISTANCE * weight) * speed;
    const wheelTopSpeed = wheels.length ? Math.min(...wheels.map(wheel => wheel.model.maxSpeed)) : 0;
    const topSpeed = Math.min(speedForPower(resistancePower, usablePower), wheelTopSpeed);
    const cruisePower = resistancePower(CRUISE_SPEED) / DRIVE_EFFICIENCY;

    const loads = this.wheelLoads();
    const frontLoad = wheels.reduce((total, wheel, index) => total + (wheel.position[2] < centerOfMass.z ? loads[index] : 0), 0);
    const hoverPower = rotors.reduce((total, rotor) => total + rotorPower(rotor.model, weight / rotors.length), 0)
      * rotorTuning.flightDrain; // what hovering really costs the batteries, rotor heat included
    const surgeWatts = sum(surges, 'surgeWatts');
    const surgeJoules = sum(surges, 'surgeJoules');

    return {
      mass,
      frontShare: wheels.length ? frontLoad / weight : 0,
      wheelPower,
      batteryPower,
      capacity,
      topSpeed,
      rangeKilometres: capacity > 0 ? (capacity / cruisePower) * CRUISE_SPEED * 3.6 : 0,
      lift: rotors.length ? sum(rotors, 'maxThrust') / weight : 0,
      hoverPower,
      hoverMinutes: hoverPower > 0 && hoverPower <= batteryPower ? (capacity / hoverPower) * 60 : 0,
      surgeWatts,
      boostSeconds: surgeWatts > 0 ? surgeJoules / surgeWatts : 0,
      gripBalance: this.gripBalance(wheels, loads, centerOfMass),
      rolloverFactor: this.rolloverFactor(wheels, centerOfMass),
      wheelCount: wheels.length,
      batteryCount: batteries.length,
      rotorCount: rotors.length,
      surgeCount: surges.length,
      gyroCount: gyros.length,
      rotorSpread: rotorSpread(rotors.map(rotor => rotorHubPosition(rotor.model, rotor.position))),
    };
  }

  /** What would stop this design working, in plain words. */
  warnings(stats = this.stats()) {
    const warnings = [];
    if (stats.wheelCount < 3) warnings.push('Needs at least three wheels to stand up.');
    if (stats.batteryCount === 0) warnings.push('No batteries: nothing will move.');
    else if (stats.batteryPower < stats.wheelPower * 0.6) {
      warnings.push(`Batteries can only feed ${Math.round((stats.batteryPower / stats.wheelPower) * 100)}% of the motors' power.`);
    }
    if (stats.rotorCount > 0) {
      if (stats.rotorCount < 3 || !stats.rotorSpread) warnings.push('Rotors need spreading front-to-back and side-to-side to fly level.');
      if (stats.lift < 1.15) warnings.push(`Rotors can't lift this: thrust is ${Math.round(stats.lift * 100)}% of the weight.`);
      else if (stats.hoverPower > stats.batteryPower) {
        warnings.push(`Batteries can't power a hover: it needs ${kilowatts(stats.hoverPower)} kW, they give ${kilowatts(stats.batteryPower)} kW.`);
      }
    }
    if (stats.wheelCount >= 3) {
      if (stats.gripBalance < -0.07) warnings.push('Will understeer: the front slides first. Move weight forward, or fit grippier front tyres.');
      if (stats.gripBalance > 0.07) warnings.push('Will oversteer: the rear slides first. Move weight back, or fit grippier rear tyres.');
      if (stats.rolloverFactor < 1.05) warnings.push('Narrow and tall: it will roll in hard corners. Set the wheels wider or mount heavy parts lower.');
      if (wheels.every(wheel => wheel.model.looseGrip < 0.85)) {
        warnings.push('These tyres flounder in loose sand. Fit dune floaters or knobbly tyres before taking the western dune sea.');
      }
    }
    return warnings;
  }

  /** Front's share of tyre grip minus front's share of the weight: negative understeers, positive oversteers. */
  gripBalance(wheels, loads, centerOfMass) {
    if (wheels.length < 3) return 0;
    let frontGrip = 0, allGrip = 0;
    wheels.forEach((wheel, index) => {
      const grip = wheel.model.grip * loads[index];
      allGrip += grip;
      if (wheel.position[2] < centerOfMass.z) frontGrip += grip;
    });
    if (allGrip <= 0) return 0;
    const frontShare = wheels.reduce((total, wheel, index) => total + (wheel.position[2] < centerOfMass.z ? loads[index] : 0), 0)
      / loads.reduce((sum, load) => sum + load, 0);
    return frontGrip / allGrip - frontShare;
  }

  /** Half the mean track width over the centre-of-mass height: under ~1 it wants to roll over. */
  rolloverFactor(wheels, centerOfMass) {
    if (wheels.length < 3) return 2;
    const trackHalf = wheels.reduce((sum, wheel) => sum + Math.abs(wheelHubPosition(wheel.model, wheel.position, this.rideHeight)[0]), 0) / wheels.length;
    const comHeight = Math.max(centerOfMass.y, 0.05) + this.rideHeight;
    return trackHalf / comHeight;
  }

  massItems() {
    const body = this.body();
    const items = this.frameTubes().map(({ start, end }) => ({
      mass: distance(start, end) * TUBE_MASS_PER_METRE,
      position: start.map((value, axis) => (value + end[axis]) / 2),
    }));
    const middleZ = (body.rings[0].z + body.rings.at(-1).z) / 2;
    items.push({ mass: body.floorMass, position: [0, 0.02, middleZ] });
    items.push({ mass: DRIVER_MASS, position: [body.seat[0], DRIVER_HEIGHT, body.seat[2]] });
    for (const placed of this.placedParts()) {
      const position = placed.part === 'wheel' ? wheelHubPosition(placed.model, placed.position, this.rideHeight) : placed.position;
      items.push({ mass: placed.model.mass, position });
    }
    for (const [slot, style] of Object.entries(this.panels)) {
      const mass = PANEL_SLOTS[slot].styles[style].mass;
      if (mass > 0) items.push({ mass, position: slotAnchor(body, slot) });
    }
    return items;
  }

  placement(mount, position) {
    return { mountId: mount.id, part: mount.part, modelKey: mount.model, model: MODELS[mount.part][mount.model], position };
  }
}

/** Box-parts (batteries, capacitors) can't overlap each other or their own mirror twin. */
function boxClash(model, candidates, existing, noun) {
  const boxes = existing.map(placed => box(placed.position, placed.model.size));
  const newBoxes = candidates.map(position => box(position, model.size));
  if (newBoxes.length === 2 && newBoxes[0].intersectsBox(newBoxes[1])) return 'Too close to the centre line to mirror. Turn mirroring off.';
  return newBoxes.some(newBox => boxes.some(other => newBox.intersectsBox(other))) ? `Overlaps another ${noun}.` : null;
}

function wheelClash(model, candidates, existing, rideHeight) {
  const hubs = candidates.map(position => wheelHubPosition(model, position, rideHeight));
  if (hubs.length === 2 && Math.abs(hubs[0][0] - hubs[1][0]) < model.width) return 'Too close to the centre line to mirror. Turn mirroring off.';
  for (const placed of existing) {
    const other = wheelHubPosition(placed.model, placed.position, rideHeight);
    for (const hub of hubs) {
      const overlapAlong = Math.abs(hub[2] - other[2]) < model.radius + placed.model.radius;
      const overlapAcross = Math.abs(hub[0] - other[0]) < (model.width + placed.model.width) / 2 + 0.02;
      if (overlapAlong && overlapAcross) return 'Overlaps another wheel.';
    }
  }
  return null;
}

function rotorClash(model, candidates, existing) {
  const hubs = candidates.map(position => rotorHubPosition(model, position));
  if (hubs.length === 2 && distance(hubs[0], hubs[1]) < model.bladeRadius * 2) return 'Too close to the centre line to mirror. Turn mirroring off.';
  for (const placed of existing) {
    const other = rotorHubPosition(placed.model, placed.position);
    if (hubs.some(hub => distance(hub, other) < model.bladeRadius + placed.model.bladeRadius)) return 'Blades would hit another rotor.';
  }
  return null;
}

/** True when rotor hubs spread both front-to-back and side-to-side, so the mixer can pitch and roll. */
function rotorSpread(hubs) {
  if (hubs.length < 3) return false;
  const span = axis => Math.max(...hubs.map(hub => hub[axis])) - Math.min(...hubs.map(hub => hub[axis]));
  return span(0) > 0.5 && span(2) > 0.5;
}

/** Highest speed a power budget can hold against a resistance curve, by bisection. */
function speedForPower(resistancePower, power) {
  if (power <= 0) return 0;
  let low = 0;
  let high = 200;
  for (let step = 0; step < 40; step++) {
    const middle = (low + high) / 2;
    if (resistancePower(middle) > power) high = middle;
    else low = middle;
  }
  return low;
}

function box(position, size) {
  const centre = new THREE.Vector3(...position);
  const half = new THREE.Vector3(...size).multiplyScalar(0.5).addScalar(PART_GAP / 2);
  return new THREE.Box3(centre.clone().sub(half), centre.clone().add(half));
}

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function kilowatts(watts) {
  return Math.round(watts / 1000);
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
