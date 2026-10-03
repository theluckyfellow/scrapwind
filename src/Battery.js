import * as THREE from 'three';
import { Part } from './Part.js';
import { toonMesh, toonMaterial } from './toon.js';

const CASING_COLOR = 0x30373a;
const FULL_COLOR = new THREE.Color(0x6fe36f);
const HALF_COLOR = new THREE.Color(0xffb13a);
const EMPTY_COLOR = new THREE.Color(0xff4a3a);
const STRIP_HEIGHT = 0.02;

/**
 * Battery: one battery pack bolted to the frame. It holds its own charge, and its light strip shows how full
 * it is. The BatteryPack draws on all of a vehicle's batteries together; Chassis gives each one a collision box.
 */
export class Battery extends Part {
  model;
  charge;        // watt-hours left
  strip;

  constructor(name, model, position, mountId) {
    super(name, position, mountId);
    this.model = model;
    this.charge = model.capacity;
    this.buildVisual();
  }

  capacity() { return this.model.capacity; }
  maxPower() { return this.model.maxPower; }
  chargeLeft() { return this.charge; }
  size() { return this.model.size; }

  /** Takes energy out (positive watt-hours) or puts it back (negative), staying between empty and full. */
  drain(wattHours) {
    this.charge = THREE.MathUtils.clamp(this.charge - wattHours, 0, this.model.capacity);
  }

  updateVisual() {
    const fraction = this.charge / this.model.capacity;
    const color = fraction > 0.5
      ? HALF_COLOR.clone().lerp(FULL_COLOR, (fraction - 0.5) * 2)
      : EMPTY_COLOR.clone().lerp(HALF_COLOR, fraction * 2);
    this.strip.material.color.copy(color);
    this.strip.material.emissive.copy(color);
  }

  reset() {
    super.reset();
    this.charge = this.model.capacity;
  }

  buildVisual() {
    const [width, height, depth] = this.model.size;
    this.visual.add(toonMesh(new THREE.BoxGeometry(width, height, depth), CASING_COLOR, { outline: 0.015 }));
    this.strip = new THREE.Mesh(
      new THREE.BoxGeometry(width * 0.7, STRIP_HEIGHT, depth * 0.12),
      toonMaterial(FULL_COLOR, { emissive: FULL_COLOR, emissiveIntensity: 0.8 }),
    );
    this.strip.position.y = height / 2 + STRIP_HEIGHT / 2;
    this.visual.add(this.strip);
  }
}
