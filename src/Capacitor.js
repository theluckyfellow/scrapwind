import * as THREE from 'three';
import { Part } from './Part.js';
import { toonMesh, toonMaterial } from './toon.js';

const CASING_COLOR = 0x2e3a3f;
const STRIP_COLOR = new THREE.Color(0x5fd8ff);
const SPARK_COLOR = new THREE.Color(0xeafcff);
const TERMINAL_COLOR = 0x8a9496;
const STRIP_HEIGHT = 0.024;
const REARM_FRACTION = 0.15; // once flat, a capacitor stays flat until it holds a real charge again

/**
 * Capacitor: a surge capacitor bolted to the frame. It holds a burst of energy the hub motors can draw
 * on top of whatever the batteries are giving — that's the boost — then trickles itself full again from
 * the BatteryPack. Its light strip shows the charge, and flashes white while it is dumping.
 * Vehicle asks all of them together how much surge they can give and refills them when boost is off.
 */
export class Capacitor extends Part {
  model;
  charge;            // joules left in the burst
  rearmed = true;    // false once drained flat: the surge gate stays shut until there's charge worth surging
  deliveredWatts = 0;

  constructor(name, model, position, mountId) {
    super(name, position, mountId);
    this.model = model;
    this.charge = model.surgeJoules;
    this.buildVisual();
  }

  size() { return this.model.size; }

  /** Watts it can add right now: full burst while it holds any charge at all — but a drained can
   * stays out of the game until it has recharged a real fraction, so holding boost pulses cleanly
   * instead of flickering on every trickle sliver. */
  availableSurge() {
    if (this.charge <= 0) this.rearmed = false;
    else if (!this.rearmed) this.rearmed = this.charge >= this.model.surgeJoules * REARM_FRACTION;
    return this.rearmed && this.charge > 0 ? this.model.surgeWatts : 0;
  }

  /** Watts it wants from the batteries to top itself up; zero once full. */
  rechargeDemand() {
    return this.charge < this.model.surgeJoules ? this.model.rechargeWatts : 0;
  }

  /** Forgets last step's delivery; Vehicle calls this at the start of every step. */
  beginStep() {
    this.deliveredWatts = 0;
  }

  /** Draws watts for this step, within the energy the can actually holds. */
  deliver(watts, dt) {
    const energy = Math.min(watts * dt, this.charge);
    this.charge -= energy;
    this.deliveredWatts = energy / Math.max(dt, 1e-6);
  }

  /** Refills from watts granted by the batteries, never past full. */
  chargeWith(watts, dt) {
    this.charge = Math.min(this.charge + watts * dt, this.model.surgeJoules);
  }

  updateVisual() {
    const fraction = this.charge / this.model.surgeJoules;
    const strip = this.strip.material;
    strip.color.copy(STRIP_COLOR).lerp(SPARK_COLOR, this.deliveredWatts > 0 ? 0.8 : 0);
    strip.emissive.copy(strip.color);
    strip.emissiveIntensity = 0.3 + fraction * 1.1 + (this.deliveredWatts > 0 ? 1.5 : 0);
  }

  reset() {
    super.reset();
    this.charge = this.model.surgeJoules;
    this.rearmed = true;
    this.deliveredWatts = 0;
  }

  buildVisual() {
    const [width, height, depth] = this.model.size;
    const radius = Math.min(width, depth) / 2;
    const casing = toonMesh(new THREE.CylinderGeometry(radius, radius * 1.06, height, 14), CASING_COLOR, { outline: 0.015 });
    casing.rotation.z = Math.PI / 2;
    casing.rotation.y = Math.PI / 2;
    this.visual.add(casing);
    for (const side of [-1, 1]) {
      const terminal = toonMesh(new THREE.CylinderGeometry(radius * 0.45, radius * 0.45, 0.05, 10), TERMINAL_COLOR, { outline: 0 });
      terminal.position.set(side * (depth / 2 + 0.02), height * 0.25, 0);
      terminal.rotation.z = Math.PI / 2;
      this.visual.add(terminal);
    }
    this.strip = new THREE.Mesh(
      new THREE.BoxGeometry(depth * 0.7, STRIP_HEIGHT, radius * 2.2),
      toonMaterial(STRIP_COLOR, { emissive: STRIP_COLOR, emissiveIntensity: 1 }),
    );
    this.strip.position.y = height / 2 + STRIP_HEIGHT / 2;
    this.visual.add(this.strip);
  }
}