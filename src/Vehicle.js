import * as THREE from 'three';
import { Chassis } from './Chassis.js';
import { Wheel } from './Wheel.js';
import { Battery } from './Battery.js';
import { Rotor } from './Rotor.js';
import { BatteryPack } from './BatteryPack.js';
import { Drivetrain } from './Drivetrain.js';
import { FlightController } from './FlightController.js';
import { RIDE_HEIGHT_RANGE } from './catalog.js';
import { disposeTree } from './toon.js';

export const handlingTuning = {
  maxSteerDegrees: 32,
  highSpeedSteerDegrees: 9,    // steering narrows to this at speed, so the stick stays usable
  steerFalloffSpeed: 32,       // m/s where steering has narrowed fully
  steerSpeed: 3.2,             // rad/s the steering wheels can turn
  antiRollStiffness: 5000,     // N/m per left–right pair of wheels, resisting body roll
};

const STEER_MARGIN = 0.3;      // m a wheel must sit ahead of the centre of mass to steer
const PAIR_DISTANCE = 0.35;    // m: a left and a right wheel this close front-to-back share an anti-roll bar
const RIDE_HEIGHT_RATE = 0.2;  // m/s the adjustable suspension rises or falls
const INPUT_THRESHOLD = 0.1;
const SPAWN_CLEARANCE = 0.3;   // m the vehicle drops onto the ground at spawn
const FLIP_MAX_SPEED = 6;      // m/s; flipping upright only works when nearly stopped
const FLIP_LIFT = 1.6;         // m
const LOCAL_UP = new THREE.Vector3(0, 1, 0);

// How to make each kind of part from a Blueprint placement.
const PART_MAKERS = {
  wheel: (placement, name) => new Wheel(name, placement.model, vector(placement.position), placement.mountId),
  battery: (placement, name) => new Battery(name, placement.model, vector(placement.position), placement.mountId),
  rotor: (placement, name, index) => {
    const [x, , z] = placement.position;
    // Diagonal rotors spin the same way, so at equal thrust their twists cancel.
    const spin = Math.sign(x * z) || (index % 2 === 0 ? 1 : -1);
    return new Rotor(name, placement.model, vector(placement.position), spin, placement.mountId);
  },
};

/**
 * Vehicle: one build from a Blueprint, alive in the physics world. A Chassis with Parts bolted on (Wheels,
 * Batteries, Rotors), a Drivetrain asking the hub motors for torque, a BatteryPack paying for it, and a
 * FlightController flying the rotors. Game steps it with Controls; the Garage shows one standing still;
 * ChaseCamera and Telemetry read it through methods.
 */
export class Vehicle {
  blueprint;
  chassis;
  parts = [];
  drivetrain = new Drivetrain();
  flightController = new FlightController();
  batteryPack;
  antiRollPairs = [];
  steeringLineZ = 0;          // chassis-local z of the line the steering wheels turn about (the back axle)
  rotorsDeployed = false;
  steerAngle = 0;
  currentRideHeight;
  spawnPosition;
  spawnQuaternion;

  constructor(world, blueprint, groundPosition, spawnHeading) {
    this.blueprint = blueprint;
    this.currentRideHeight = blueprint.rideHeight;
    this.spawnPosition = groundPosition.clone().add(new THREE.Vector3(0, blueprint.rideHeight + SPAWN_CLEARANCE, 0));
    this.spawnQuaternion = new THREE.Quaternion().setFromAxisAngle(LOCAL_UP, spawnHeading);
    this.chassis = new Chassis(world, blueprint, this.spawnPosition, this.spawnQuaternion);

    const centerOfMass = blueprint.massProperties().centerOfMass;
    const counts = {};
    blueprint.placedParts().forEach((placement, index) => {
      counts[placement.part] = (counts[placement.part] ?? 0) + 1;
      const name = partName(placement, centerOfMass, counts[placement.part]);
      this.parts.push(PART_MAKERS[placement.part](placement, name, index));
    });
    for (const part of this.parts) this.chassis.visual.add(part.visual);

    const loads = blueprint.wheelLoads();
    this.wheels().forEach((wheel, index) => wheel.fitSuspension(loads[index], this.currentRideHeight));
    for (const battery of this.batteries()) this.chassis.attachBox(world, battery.size(), battery.mountPoint);
    this.batteryPack = new BatteryPack(this.batteries());
    this.assignSteering(centerOfMass);
    this.antiRollPairs = pairWheels(this.wheels());
  }

  wheels() { return this.parts.filter(part => part instanceof Wheel); }
  batteries() { return this.parts.filter(part => part instanceof Battery); }
  rotors() { return this.parts.filter(part => part instanceof Rotor); }

  /** The root of everything drawn for this vehicle. */
  visual() { return this.chassis.visual; }

  /** Runs one physics step: ride height, suspension, power, tyres, rotors and air, in that order. */
  step(controls, track, dt) {
    this.chassis.beginStep();
    for (const part of this.parts) part.clearForces();
    const wheels = this.wheels();
    const rotors = this.rotors();

    this.adjustRideHeight(controls.value('rideHeight'), wheels, dt);
    this.steer(controls.value('steer'), wheels, dt);
    for (const wheel of wheels) wheel.sense(this.chassis, track, dt);
    this.applyAntiRoll();
    const grounded = wheels.some(wheel => wheel.touchingGround());

    // With the rotors out, the triggers fly instead of drive.
    const throttle = this.rotorsDeployed ? 0 : controls.value('throttle');
    this.drivetrain.update(throttle, controls.value('brake'), this.chassis.forwardSpeed());
    this.batteryPack.beginStep();

    // Rotors get first call on the power: staying in the air matters more than the wheels.
    for (const rotor of rotors) rotor.deployTowards(this.rotorsDeployed, dt);
    if (rotors.length > 0 && rotors.every(rotor => rotor.deployed())) {
      this.flightController.fly(this.chassis, rotors, controls, grounded, track);
    } else {
      this.flightController.disengage();
      for (const rotor of rotors) rotor.command(0);
    }
    const rotorShare = this.batteryPack.request(rotors.reduce((sum, rotor) => sum + rotor.powerDemand(), 0));
    for (const rotor of rotors) rotor.limitPower(rotorShare);

    // Then the hub motors share what is left.
    const requests = wheels.map(wheel => this.drivetrain.motorRequest(wheel));
    const wheelDemand = wheels.reduce((sum, wheel, index) => sum + wheel.motorPower(requests[index]), 0);
    const wheelShare = this.batteryPack.request(wheelDemand);
    const handbrake = controls.value('handbrake') > 0.5;
    wheels.forEach((wheel, index) => {
      wheel.grip(this.chassis, track, requests[index] * wheelShare, this.drivetrain.brakeForce(wheel),
        this.drivetrain.handbrakeForce(wheel, handbrake), dt);
    });
    for (const rotor of rotors) rotor.spin(this.chassis, dt);

    this.batteryPack.recover(wheels.reduce((sum, wheel) => sum + wheel.brakingPower, 0), dt);
    this.batteryPack.finishStep(dt);

    this.chassis.applyAero(rotors.reduce((sum, rotor) => sum + rotor.dragArea(), 0));
    if (!grounded && !this.rotorsDeployed) {
      this.chassis.dampTumble();
      this.chassis.applyAirControl(controls.value('tiltForward'), controls.value('tiltRight'));
    }
  }

  /** Records the pose Rapier produced; Game calls this right after the world steps. */
  afterPhysicsStep() {
    this.chassis.capturePose();
  }

  /** Draws the vehicle between the last two physics steps (alpha 0..1). */
  updateVisual(alpha, frameSeconds) {
    this.chassis.updateVisual(alpha);
    for (const part of this.parts) part.updateVisual(frameSeconds);
  }

  /** Swings the rotors out or folds them away; does nothing on a build without rotors. */
  toggleRotors() {
    if (this.rotors().length > 0) this.rotorsDeployed = !this.rotorsDeployed;
  }

  /** Sets the vehicle back on its wheels, facing the way it was, if it is nearly stopped. */
  flipUpright() {
    if (this.chassis.speed() > FLIP_MAX_SPEED) return;
    const forward = this.chassis.forward().setY(0);
    if (forward.lengthSq() < 1e-4) forward.set(0, 0, -1);
    const heading = Math.atan2(-forward.x, -forward.z);
    const position = this.chassis.drawnPosition().add(new THREE.Vector3(0, FLIP_LIFT, 0));
    this.chassis.placeAt(position, new THREE.Quaternion().setFromAxisAngle(LOCAL_UP, heading));
    for (const wheel of this.wheels()) wheel.reset();
  }

  /** Back to the start line, charged and as good as new. */
  reset() {
    this.chassis.placeAt(this.spawnPosition, this.spawnQuaternion);
    for (const part of this.parts) part.reset();
    this.drivetrain.reset();
    this.flightController.reset();
    this.rotorsDeployed = false;
    this.steerAngle = 0;
  }

  /** Re-reads chassis tuning (inertia) after the tuning panel changes it. */
  applyMassTuning() {
    this.chassis.applyMassProperties(this.blueprint.massProperties());
  }

  /** Re-sizes every spring after the tuning panel changes suspension settings. */
  refitSuspension() {
    for (const wheel of this.wheels()) wheel.fitSuspension(wheel.restingLoad, this.currentRideHeight);
  }

  /** Stands the vehicle still at a spot with its wheels at rest, for the garage. */
  showAtRest(groundPosition, rotorsOut = false) {
    this.chassis.placeAt(groundPosition.clone().add(new THREE.Vector3(0, this.currentRideHeight, 0)), new THREE.Quaternion());
    for (const wheel of this.wheels()) wheel.settle();
    for (const rotor of this.rotors()) rotor.setDeployed(rotorsOut);
    this.updateVisual(1, 0);
  }

  /** The part whose visual contains this object, if any. */
  partOwning(object) {
    for (let node = object; node; node = node.parent) {
      const part = this.parts.find(candidate => candidate.visual === node);
      if (part) return part;
    }
    return null;
  }

  /** Takes the vehicle out of the physics world and frees what it drew. */
  dispose(world) {
    this.chassis.dispose(world);
    this.chassis.visual.removeFromParent();
    disposeTree(this.chassis.visual);
  }

  speed() { return this.chassis.speed(); }
  altitude() { return this.chassis.drawnPosition().y; }
  drawnPosition(target) { return this.chassis.drawnPosition(target); }
  drawnQuaternion(target) { return this.chassis.drawnQuaternion(target); }
  directionLabel() { return this.drivetrain.directionLabel(); }
  chargeFraction() { return this.batteryPack.chargeFraction(); }
  powerDraw() { return this.batteryPack.powerDraw(); }
  maxPower() { return this.batteryPack.maxPower(); }
  rideHeight() { return this.currentRideHeight; }
  flying() { return this.rotorsDeployed; }
  hasRotors() { return this.rotors().length > 0; }
  mountSurfaces() { return this.chassis.mountSurfaces(); }
  partVisuals() { return this.parts.map(part => part.visual); }
  showPanels(visible) { this.chassis.bodywork.showPanels(visible); }
  wheelReadouts() { return this.wheels().map(wheel => wheel.readout()); }
  appliedForces() { return this.parts.flatMap(part => part.forces()); }

  /** The test vehicle's adjustable suspension: raise or lower while driving (input −1..1). */
  adjustRideHeight(input, wheels, dt) {
    if (!this.blueprint.adjustableRideHeight || Math.abs(input) < INPUT_THRESHOLD) return;
    const height = THREE.MathUtils.clamp(this.currentRideHeight + input * RIDE_HEIGHT_RATE * dt, RIDE_HEIGHT_RANGE.min, RIDE_HEIGHT_RANGE.max);
    if (height === this.currentRideHeight) return;
    this.currentRideHeight = height;
    for (const wheel of wheels) wheel.fitSuspension(wheel.restingLoad, height);
  }

  /** Wheels well ahead of the centre of mass steer; the rest set the line they turn about. */
  assignSteering(centerOfMass) {
    const wheels = this.wheels();
    for (const wheel of wheels) wheel.setSteering(wheel.hubZ() < centerOfMass.z - STEER_MARGIN);
    const fixed = wheels.filter(wheel => !wheel.steers());
    this.steeringLineZ = fixed.length ? fixed.reduce((sum, wheel) => sum + wheel.hubZ(), 0) / fixed.length : centerOfMass.z;
  }

  /** Narrows steering with speed, eases the wheels toward the target and points each at one turning centre. */
  steer(input, wheels, dt) {
    const narrowing = THREE.MathUtils.clamp(Math.abs(this.chassis.forwardSpeed()) / handlingTuning.steerFalloffSpeed, 0, 1);
    const maxAngle = THREE.MathUtils.degToRad(
      THREE.MathUtils.lerp(handlingTuning.maxSteerDegrees, handlingTuning.highSpeedSteerDegrees, narrowing),
    );
    const maxChange = handlingTuning.steerSpeed * dt;
    this.steerAngle += THREE.MathUtils.clamp(input * maxAngle - this.steerAngle, -maxChange, maxChange);

    const steering = wheels.filter(wheel => wheel.steers());
    const reach = Math.max(...steering.map(wheel => this.steeringLineZ - wheel.hubZ()), 0.1);
    for (const wheel of steering) {
      wheel.setSteerAngle(ackermannAngle(this.steerAngle, reach, this.steeringLineZ - wheel.hubZ(), wheel.hubX()));
    }
  }

  /** Each left–right pair's anti-roll bar moves load from the more compressed wheel to the other, resisting lean. */
  applyAntiRoll() {
    for (const [left, right] of this.antiRollPairs) {
      if (!left.touchingGround() || !right.touchingGround()) continue;
      const transfer = (left.compressionAmount() - right.compressionAmount()) * handlingTuning.antiRollStiffness;
      left.shareLoad(this.chassis, transfer);
      right.shareLoad(this.chassis, -transfer);
    }
  }
}

/**
 * Ackermann steering for any layout: every steering wheel points at one turning centre on the line through
 * the fixed wheels, so none of them scrub. steerAngle is the angle of a wheel `reach` metres ahead of that
 * line; `ahead` and `x` place this wheel. Positive steers right.
 */
function ackermannAngle(steerAngle, reach, ahead, x) {
  if (Math.abs(steerAngle) < 1e-4) return steerAngle;
  const turnRadius = reach / Math.tan(Math.abs(steerAngle));
  const sideways = steerAngle > 0 ? turnRadius - x : turnRadius + x;
  return Math.sign(steerAngle) * Math.atan2(ahead, Math.max(sideways, 0.1));
}

/** Pairs each left wheel with the right wheel nearest it front-to-back, for anti-roll bars. */
function pairWheels(wheels) {
  const pairs = [];
  const rights = wheels.filter(wheel => wheel.side > 0);
  for (const left of wheels.filter(wheel => wheel.side < 0)) {
    const right = rights
      .filter(candidate => Math.abs(candidate.hubZ() - left.hubZ()) < PAIR_DISTANCE)
      .sort((a, b) => Math.abs(a.hubZ() - left.hubZ()) - Math.abs(b.hubZ() - left.hubZ()))[0];
    if (right) pairs.push([left, right]);
  }
  return pairs;
}

/** "Front left wheel", "Rear battery 2" and so on, for telemetry. */
function partName(placement, centerOfMass, count) {
  const [x, , z] = placement.position;
  const end = z < centerOfMass.z ? 'Front' : 'Rear';
  const side = x < -0.05 ? ' left' : x > 0.05 ? ' right' : '';
  return placement.part === 'wheel' ? `${end}${side} wheel` : `${end}${side} ${placement.part} ${count}`;
}

function vector(position) {
  return new THREE.Vector3(...position);
}
