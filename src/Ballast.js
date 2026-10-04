import * as THREE from 'three';
import { Part } from './Part.js';
import { toonMesh, toonMaterial } from './toon.js';

const LEAD_COLOR = 0x3a3f44;
const STRIPE_COLOR = 0xf2d14b;

/**
 * Ballast: a lead block bolted to the frame. It does nothing but weigh, exactly where you put it —
 * that's the point: it moves the centre of mass, plants an end of the vehicle, or brings stunt weight.
 * Vehicle collides it like any other box; Blueprint counts its mass like everything else.
 */
export class Ballast extends Part {
  model;

  constructor(name, model, position, mountId) {
    super(name, position, mountId);
    this.model = model;
    this.buildVisual();
  }

  size() { return this.model.size; }

  buildVisual() {
    const [width, height, depth] = this.model.size;
    this.visual.add(toonMesh(new THREE.BoxGeometry(width, height, depth), LEAD_COLOR, { outline: 0.012 }));
    // A painted hazard stripe along the top, so the block reads as deliberate weight, not a stray part.
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(width * 0.92, 0.01, depth * 0.3),
      toonMaterial(STRIPE_COLOR),
    );
    stripe.position.y = height / 2 + 0.005;
    this.visual.add(stripe);
  }
}
