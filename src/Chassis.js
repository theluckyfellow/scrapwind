import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Bodywork } from './Bodywork.js';

export const chassisTuning = {
  inertiaScale: 1.3,         // above 1 makes it slower to pitch and roll than the parts' masses alone suggest
  airControlTorque: 2200,    // N·m from the stick while airborne with the rotors stowed
  airYawTorque: 900,         // N·m of mid-air yaw from the steering itself
  airborneSpinDamping: 2.0,  // 1/s; calms pitch and roll tumbling off ramp lips, so jumps land wheels-down more often
};

const COLLISION_TUBE_RADIUS = 0.06;  // m; fatter than the drawn tubes so thin rails don't slip past rocks
const FLOOR_THICKNESS = 0.03;
const AIR_DENSITY = 1.2; // kg/m³
const LOCAL_UP = new THREE.Vector3(0, 1, 0);
const LOCAL_FORWARD = new THREE.Vector3(0, 0, -1);
const LOCAL_RIGHT = new THREE.Vector3(1, 0, 0);

/**
 * Chassis: the vehicle's rigid body in Rapier, built from a Blueprint: a collision capsule per frame tube,
 * the floor pan and a box per battery, with mass and inertia worked out from every part. It carries the
 * Bodywork you see. Parts push on it through push() and twist(); Vehicle asks it where it is and how it moves.
 * It keeps its last two physics poses so the bodywork can be drawn smoothly between physics steps.
 */
export class Chassis {
  body;
  bodywork;
  visual = new THREE.Group();
  inertia = new THREE.Vector3(); // kg·m² about the chassis's own right, up and back axes
  dragArea;                    // m², from the design's panels
  downforceSurfaces;           // [{ position, area }] chassis-local
  designMass = 0;               // kg; Rapier's body.mass() reads 0 until the first world step

  // Pose at the start of the current physics step, used by every force calculation.
  position = new THREE.Vector3();
  quaternion = new THREE.Quaternion();
  // The two most recent post-step poses, blended for drawing.
  previousPosition = new THREE.Vector3();
  previousQuaternion = new THREE.Quaternion();
  latestPosition = new THREE.Vector3();
  latestQuaternion = new THREE.Quaternion();

  constructor(world, blueprint, spawnPosition, spawnQuaternion) {
    const bodyDescription = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawnPosition.x, spawnPosition.y, spawnPosition.z)
      .setRotation(spawnQuaternion)
      .setCanSleep(false)
      .setCcdEnabled(true);
    this.body = world.createRigidBody(bodyDescription);

    for (const tube of blueprint.frameTubes()) this.attachTube(world, tube);
    this.attachFloor(world, blueprint.body());
    this.applyMassProperties(blueprint.massProperties());
    this.dragArea = blueprint.dragArea();
    this.downforceSurfaces = blueprint.downforceSurfaces().map(surface => ({
      position: new THREE.Vector3(...surface.position),
      area: surface.area,
    }));

    this.bodywork = new Bodywork(blueprint);
    this.visual.add(this.bodywork.group);
    this.capturePose();
    this.capturePose();
  }

  /** Sets mass, centre of mass and inertia; colliders have no density, so these are the whole story. */
  applyMassProperties({ mass, centerOfMass, inertia }) {
    this.designMass = mass;
    this.inertia.copy(inertia).multiplyScalar(chassisTuning.inertiaScale);
    this.body.setAdditionalMassProperties(mass, centerOfMass, this.inertia, { x: 0, y: 0, z: 0, w: 1 }, true);
  }

  /** Adds a box to collide with (a battery, say), chassis-local. */
  attachBox(world, size, position) {
    const description = RAPIER.ColliderDesc.cuboid(size[0] / 2, size[1] / 2, size[2] / 2)
      .setTranslation(position.x, position.y, position.z)
      .setDensity(0)
      .setFriction(0.5);
    world.createCollider(description, this.body);
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

  /** The design's mass. Kept from what we set: Rapier reports its own number only after the first step. */
  mass() { return this.designMass; }
  /** Total downforce area (m²) of the design's wings and splitters, for grip-vs-speed estimates. */
  downforceArea() { return this.downforceSurfaces.reduce((sum, surface) => sum + surface.area, 0); }
  localCenterOfMass(target = new THREE.Vector3()) { return target.copy(this.body.localCom()); }
  worldCenterOfMass(target = new THREE.Vector3()) { return target.copy(this.body.worldCom()); }
  /**
   * Rotational inertia about the chassis's own right, up and back axes. Kept from what we set, because Rapier
   * reports its principal inertia sorted by size, not in the chassis's axis order.
   */
  principalInertia(target = new THREE.Vector3()) { return target.copy(this.inertia); }

  /** Pushes on the chassis at a world point (N). */
  push(force, worldPoint) { this.body.addForceAtPoint(force, worldPoint, true); }

  /** Twists the chassis about a world axis (N·m). */
  twist(torque) { this.body.addTorque(torque, true); }

  /** Air resistance against the direction of travel, and downforce from wings and splitters at speed. */
  applyAero(extraDragArea) {
    const velocity = this.linearVelocity();
    const speed = velocity.length();
    if (speed < 0.01) return;
    const drag = velocity.multiplyScalar(-0.5 * AIR_DENSITY * (this.dragArea + extraDragArea) * speed);
    this.body.addForce(drag, true);

    const forwardSpeed = Math.max(this.forwardSpeed(), 0);
    const pressure = 0.5 * AIR_DENSITY * forwardSpeed * forwardSpeed;
    if (pressure < 1) return;
    const down = this.up().negate();
    for (const surface of this.downforceSurfaces) {
      this.push(down.clone().multiplyScalar(pressure * surface.area), this.toWorld(surface.position));
    }
  }

  /** Lets the driver pitch and roll mid-jump; inputs are -1..1, forward tilts the nose down. */
  applyAirControl(tiltForward, tiltRight) {
    const torque = this.right().multiplyScalar(-tiltForward * chassisTuning.airControlTorque)
      .add(this.forward().multiplyScalar(tiltRight * chassisTuning.airControlTorque));
    this.twist(torque);
  }

  /** Steering while airborne yaws the nose around, so a jump can be lined up for the landing. */
  applyAirYaw(steer) {
    if (Math.abs(steer) < 0.05) return;
    this.twist(this.up().multiplyScalar(-steer * chassisTuning.airYawTorque));
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

  /** Takes the body (and its colliders) out of the physics world. */
  dispose(world) {
    world.removeRigidBody(this.body);
  }

  /** The Rapier body, only for physics queries that must ignore this vehicle. */
  physicsBody() { return this.body; }

  /** Meshes parts can be mounted on, for the garage. */
  mountSurfaces() { return this.bodywork.mountSurfaces; }

  /** Moves the bodywork to a blend of the last two physics poses (alpha 0 = previous, 1 = latest). */
  updateVisual(alpha) {
    this.visual.position.lerpVectors(this.previousPosition, this.latestPosition, alpha);
    this.visual.quaternion.slerpQuaternions(this.previousQuaternion, this.latestQuaternion, alpha);
  }

  /** The drawn (blended) position, for the camera. */
  drawnPosition(target = new THREE.Vector3()) { return target.copy(this.visual.position); }
  drawnQuaternion(target = new THREE.Quaternion()) { return target.copy(this.visual.quaternion); }

  attachTube(world, { start, end }) {
    const from = new THREE.Vector3(...start);
    const to = new THREE.Vector3(...end);
    const length = from.distanceTo(to);
    if (length < 0.01) return;
    const middle = from.clone().lerp(to, 0.5);
    const rotation = new THREE.Quaternion().setFromUnitVectors(LOCAL_UP, to.clone().sub(from).normalize());
    const description = RAPIER.ColliderDesc.capsule(length / 2, COLLISION_TUBE_RADIUS)
      .setTranslation(middle.x, middle.y, middle.z)
      .setRotation(rotation)
      .setDensity(0)
      .setFriction(0.5)
      .setRestitution(0.1);
    world.createCollider(description, this.body);
  }

  /** A solid floor pan, so bottoming out lands on something even where no tube runs. */
  attachFloor(world, body) {
    for (let index = 0; index < body.rings.length - 1; index++) {
      const [here, next] = [body.rings[index], body.rings[index + 1]];
      const halfWidth = Math.min(here.bottomHalfWidth, next.bottomHalfWidth);
      const halfLength = (next.z - here.z) / 2;
      const y = Math.max(here.bottom, next.bottom);
      const description = RAPIER.ColliderDesc.cuboid(halfWidth, FLOOR_THICKNESS / 2, halfLength)
        .setTranslation(0, y, (here.z + next.z) / 2)
        .setDensity(0)
        .setFriction(0.5);
      world.createCollider(description, this.body);
    }
  }
}
