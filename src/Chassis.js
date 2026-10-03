import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { toonMesh, toonMaterial } from './toon.js';

export const chassisTuning = {
  mass: 650,                 // kg, the whole buggy
  centerOfMassHeight: -0.3,  // m relative to the chassis origin; low keeps it on its wheels
  inertiaScale: 1.6,         // above 1 acts like weight out at the corners: slower to pitch and roll
  dragArea: 0.9,             // m², drag coefficient × frontal area
  airControlTorque: 2200,    // N·m from the stick while airborne with the rotors stowed
  airborneSpinDamping: 2.0,  // 1/s; calms pitch and roll tumbling off ramp lips, so jumps land wheels-down more often
};

const HALF_EXTENTS = new THREE.Vector3(0.8, 0.3, 1.75);
const AIR_DENSITY = 1.2; // kg/m³
const LOCAL_UP = new THREE.Vector3(0, 1, 0);
const LOCAL_FORWARD = new THREE.Vector3(0, 0, -1);
const LOCAL_RIGHT = new THREE.Vector3(1, 0, 0);

const PAINT = 0xe2582c;
const CAGE = 0x2d2a28;
const STEEL = 0x8a9496;
const SEAT = 0x4a3b33;
const DRIVER_SUIT = 0x3f8f8a;
const HELMET = 0xf2d14b;

/**
 * Chassis: the buggy's rigid body in Rapier, plus the bodywork you see.
 * Parts push on it through push() and twist(); Vehicle asks it where it is and how it moves.
 * It keeps its last two physics poses so the bodywork can be drawn smoothly between physics steps.
 */
export class Chassis {
  body;
  collider;
  visual = new THREE.Group();

  // Pose at the start of the current physics step, used by every force calculation.
  position = new THREE.Vector3();
  quaternion = new THREE.Quaternion();
  // The two most recent post-step poses, blended for drawing.
  previousPosition = new THREE.Vector3();
  previousQuaternion = new THREE.Quaternion();
  latestPosition = new THREE.Vector3();
  latestQuaternion = new THREE.Quaternion();

  constructor(world, spawnPosition, spawnQuaternion) {
    const bodyDescription = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawnPosition.x, spawnPosition.y, spawnPosition.z)
      .setRotation(spawnQuaternion)
      .setCanSleep(false)
      .setCcdEnabled(true);
    this.body = world.createRigidBody(bodyDescription);

    const colliderDescription = RAPIER.ColliderDesc.cuboid(HALF_EXTENTS.x, HALF_EXTENTS.y, HALF_EXTENTS.z)
      .setFriction(0.5)
      .setRestitution(0.1);
    this.collider = world.createCollider(colliderDescription, this.body);
    this.applyMassTuning();

    this.buildBodywork();
    this.capturePose();
    this.capturePose();
  }

  /** Re-reads chassisTuning's mass, centre of mass and inertia; the tuning panel calls this. */
  applyMassTuning() {
    const { mass, centerOfMassHeight, inertiaScale } = chassisTuning;
    const width = HALF_EXTENTS.x * 2;
    const height = HALF_EXTENTS.y * 2;
    const length = HALF_EXTENTS.z * 2;
    // Solid-box inertia about each axis, scaled up because real mass sits out at the wheels.
    const inertia = {
      x: (mass / 12) * (height * height + length * length) * inertiaScale,
      y: (mass / 12) * (width * width + length * length) * inertiaScale,
      z: (mass / 12) * (width * width + height * height) * inertiaScale,
    };
    this.collider.setMassProperties(mass, { x: 0, y: centerOfMassHeight, z: 0 }, inertia, { x: 0, y: 0, z: 0, w: 1 });
  }

  /** Clears last step's forces and caches the pose every part will measure against this step. */
  beginStep() {
    this.body.resetForces(true);
    this.body.resetTorques(true);
    this.position.copy(this.body.translation());
    this.quaternion.copy(this.body.rotation());
  }

  /** Records the pose Rapier just produced, for smooth drawing between steps. */
  capturePose() {
    this.previousPosition.copy(this.latestPosition);
    this.previousQuaternion.copy(this.latestQuaternion);
    this.latestPosition.copy(this.body.translation());
    this.latestQuaternion.copy(this.body.rotation());
  }

  /** Converts a chassis-local point to world space at this step's pose. */
  toWorld(localPoint, target = new THREE.Vector3()) {
    return target.copy(localPoint).applyQuaternion(this.quaternion).add(this.position);
  }

  /** Converts a chassis-local direction to world space at this step's pose. */
  directionToWorld(localDirection, target = new THREE.Vector3()) {
    return target.copy(localDirection).applyQuaternion(this.quaternion);
  }

  up(target = new THREE.Vector3()) { return this.directionToWorld(LOCAL_UP, target); }
  forward(target = new THREE.Vector3()) { return this.directionToWorld(LOCAL_FORWARD, target); }
  right(target = new THREE.Vector3()) { return this.directionToWorld(LOCAL_RIGHT, target); }

  /** Inverse of this step's rotation, for turning world vectors into chassis-local ones. */
  inverseRotation(target = new THREE.Quaternion()) { return target.copy(this.quaternion).invert(); }

  velocityAt(worldPoint, target = new THREE.Vector3()) { return target.copy(this.body.velocityAtPoint(worldPoint)); }
  linearVelocity(target = new THREE.Vector3()) { return target.copy(this.body.linvel()); }
  angularVelocity(target = new THREE.Vector3()) { return target.copy(this.body.angvel()); }

  /** Speed along the nose direction; negative when reversing. */
  forwardSpeed() { return this.linearVelocity().dot(this.forward()); }
  speed() { return this.linearVelocity().length(); }

  mass() { return this.body.mass(); }
  localCenterOfMass(target = new THREE.Vector3()) { return target.copy(this.body.localCom()); }
  worldCenterOfMass(target = new THREE.Vector3()) { return target.copy(this.body.worldCom()); }
  /** Rotational inertia about the chassis's own right, up and back axes. */
  principalInertia(target = new THREE.Vector3()) { return target.copy(this.body.principalInertia()); }

  /** Pushes on the chassis at a world point (N). */
  push(force, worldPoint) { this.body.addForceAtPoint(force, worldPoint, true); }

  /** Twists the chassis about a world axis (N·m). */
  twist(torque) { this.body.addTorque(torque, true); }

  /** Air resistance against the direction of travel; extraDragArea comes from deployed rotors. */
  applyDrag(extraDragArea) {
    const velocity = this.linearVelocity();
    const speed = velocity.length();
    if (speed < 0.01) return;
    const dragArea = chassisTuning.dragArea + extraDragArea;
    const drag = velocity.multiplyScalar(-0.5 * AIR_DENSITY * dragArea * speed);
    this.body.addForce(drag, true);
  }

  /** Lets the driver pitch and roll the buggy mid-jump; inputs are -1..1, forward tilts the nose down. */
  applyAirControl(tiltForward, tiltRight) {
    const torque = this.right().multiplyScalar(-tiltForward * chassisTuning.airControlTorque)
      .add(this.forward().multiplyScalar(tiltRight * chassisTuning.airControlTorque));
    this.twist(torque);
  }

  /** Slows pitching and rolling (not turning) while airborne, by a fraction of the spin each second. */
  dampTumble() {
    const up = this.up();
    const angularVelocity = this.angularVelocity();
    const tumble = angularVelocity.addScaledVector(up, -angularVelocity.dot(up));
    const localTumble = tumble.applyQuaternion(this.inverseRotation());
    const torque = localTumble.multiply(this.principalInertia()).multiplyScalar(-chassisTuning.airborneSpinDamping);
    this.twist(torque.applyQuaternion(this.quaternion));
  }

  /** Teleports the chassis to a pose and stops it dead, without a blur from the old pose. */
  placeAt(position, quaternion) {
    this.body.setTranslation(position, true);
    this.body.setRotation(quaternion, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.capturePose();
    this.capturePose();
  }

  /** The Rapier body, only for physics queries that must ignore this vehicle. */
  physicsBody() { return this.body; }

  /** Moves the bodywork to a blend of the last two physics poses (alpha 0 = previous, 1 = latest). */
  updateVisual(alpha) {
    this.visual.position.lerpVectors(this.previousPosition, this.latestPosition, alpha);
    this.visual.quaternion.slerpQuaternions(this.previousQuaternion, this.latestQuaternion, alpha);
  }

  /** The drawn (blended) position, for the camera. */
  drawnPosition(target = new THREE.Vector3()) { return target.copy(this.visual.position); }
  drawnQuaternion(target = new THREE.Quaternion()) { return target.copy(this.visual.quaternion); }

  buildBodywork() {
    const add = (geometry, color, x, y, z, options) => {
      const mesh = toonMesh(geometry, color, options);
      mesh.position.set(x, y, z);
      this.visual.add(mesh);
      return mesh;
    };

    // Tub and nose
    add(new THREE.BoxGeometry(1.6, 0.42, 3.0), PAINT, 0, -0.08, 0.15);
    const nose = add(new THREE.BoxGeometry(1.4, 0.32, 0.9), PAINT, 0, -0.1, -1.55);
    nose.rotation.x = -0.28;
    add(new THREE.BoxGeometry(1.9, 0.14, 0.18), CAGE, 0, -0.2, -2.0); // front bumper
    add(new THREE.BoxGeometry(1.7, 0.14, 0.16), CAGE, 0, -0.18, 1.72); // rear bumper

    // Seat and driver
    add(new THREE.BoxGeometry(0.62, 0.5, 0.5), SEAT, 0, 0.3, 0.15);
    add(new THREE.BoxGeometry(0.5, 0.55, 0.4), DRIVER_SUIT, 0, 0.55, -0.05);
    add(new THREE.IcosahedronGeometry(0.24, 1), HELMET, 0, 0.98, -0.08);
    add(new THREE.BoxGeometry(0.34, 0.09, 0.08), CAGE, 0, 1.0, -0.3); // goggles

    // Roll cage: two hoops joined by top rails
    const tube = (x1, y1, z1, x2, y2, z2) => {
      const start = new THREE.Vector3(x1, y1, z1);
      const end = new THREE.Vector3(x2, y2, z2);
      const length = start.distanceTo(end);
      const mesh = toonMesh(new THREE.BoxGeometry(0.09, length, 0.09), CAGE, { outline: 0.02 });
      mesh.position.lerpVectors(start, end, 0.5);
      mesh.quaternion.setFromUnitVectors(LOCAL_UP, end.clone().sub(start).normalize());
      this.visual.add(mesh);
    };
    tube(-0.7, 0.12, -0.75, -0.55, 1.3, -0.45);
    tube(0.7, 0.12, -0.75, 0.55, 1.3, -0.45);
    tube(-0.7, 0.12, 0.75, -0.55, 1.3, 0.55);
    tube(0.7, 0.12, 0.75, 0.55, 1.3, 0.55);
    tube(-0.55, 1.3, -0.45, 0.55, 1.3, -0.45);
    tube(-0.55, 1.3, 0.55, 0.55, 1.3, 0.55);
    tube(-0.55, 1.3, -0.45, -0.55, 1.3, 0.55);
    tube(0.55, 1.3, -0.45, 0.55, 1.3, 0.55);

    // Engine block, exhaust stacks and a spare tyre on the back
    add(new THREE.BoxGeometry(0.95, 0.5, 0.75), STEEL, 0, 0.32, 1.15);
    for (const side of [-1, 1]) {
      const stack = add(new THREE.CylinderGeometry(0.06, 0.07, 0.7, 6), CAGE, side * 0.32, 0.75, 1.42, { outline: 0.02 });
      stack.rotation.x = 0.25;
    }
    const spare = add(new THREE.CylinderGeometry(0.36, 0.36, 0.22, 12), 0x2a2522, 0, 0.32, 1.78);
    spare.rotation.x = Math.PI / 2;

    // Headlights glow a little so they read at dusk
    const lampMaterial = toonMaterial(0xfff2c0, { emissive: 0xffe08a, emissiveIntensity: 0.6 });
    for (const side of [-1, 1]) {
      add(new THREE.BoxGeometry(0.26, 0.16, 0.08), null, side * 0.45, 0.02, -1.98, { material: lampMaterial, outline: 0.02 });
    }
  }
}
