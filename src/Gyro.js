import * as THREE from 'three';
import { Part } from './Part.js';
import { toonMesh, toonMaterial } from './toon.js';

const CASING_COLOR = 0x2e3a3f;
const RING_COLOR = 0x8a9496;
const CORE_COLOR = 0x7fd6c4;
const SPIN_RATE = 9; // rad/s the flywheel turns at, for the look of the thing

/**
 * Gyro: a spinning-mass stabilizer bolted to the frame. Each gyro in the build strengthens the
 * Vehicle's upright assist — the torque that fights a roll once the body leans too far at speed —
 * so gyro-fitted builds survive landings and clipped berms that would otherwise flip them.
 * The flywheel spins in its gimbal for show; the physics lives in Vehicle.applyUprightAssist().
 */
export class Gyro extends Part {
  model;
  flywheel;

  constructor(name, model, position, mountId) {
    super(name, position, mountId);
    this.model = model;
    this.buildVisual();
  }

  size() { return this.model.size; }

  updateVisual(frameSeconds) {
    this.flywheel.rotation.y += SPIN_RATE * frameSeconds;
  }

  buildVisual() {
    const [width, height, depth] = this.model.size;
    const radius = Math.min(width, depth) / 2;
    const casing = toonMesh(new THREE.BoxGeometry(width, height * 0.55, depth), CASING_COLOR, { outline: 0.015 });
    casing.position.y = -height * 0.22;
    this.visual.add(casing);

    this.flywheel = new THREE.Group();
    const core = toonMesh(new THREE.SphereGeometry(radius * 0.55, 12, 8), CORE_COLOR, { outline: 0 });
    core.material = toonMaterial(CORE_COLOR, { emissive: CORE_COLOR, emissiveIntensity: 0.35 });
    this.flywheel.add(core);
    const ring = toonMesh(new THREE.TorusGeometry(radius * 0.8, 0.02, 6, 24), RING_COLOR, { outline: 0 });
    ring.rotation.x = Math.PI / 2;
    this.flywheel.add(ring);
    this.flywheel.position.y = height * 0.25;
    this.visual.add(this.flywheel);
  }
}
