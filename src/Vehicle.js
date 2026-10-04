import * as THREE from 'three';
import { Chassis } from './Chassis.js';
import { Wheel } from './Wheel.js';
import { Battery } from './Battery.js';
import { Rotor } from './Rotor.js';
import { Capacitor } from './Capacitor.js';
import { Ballast } from './Ballast.js';
import { Gyro } from './Gyro.js';
import { BatteryPack } from './BatteryPack.js';
import { Drivetrain } from './Drivetrain.js';
import { FlightController } from './FlightController.js';
import { rotorTuning } from './Rotor.js';
import { RIDE_HEIGHT_RANGE } from './catalog.js';
import { disposeTree } from './toon.js';

export const handlingTuning = {
  maxSteerDegrees: 38,        // full lock at a crawl
  steerSpeed: 4.5,             // rad/s the steering wheels can turn
  steerGripMargin: 1.1,        // steering may ask the tyres for this multiple of their cornering grip
  antiRollStiffness: 5000,     // N/m per left–right pair of wheels, resisting body roll
  yawAssistTorque: 90,         // N·m of turn-in per rad of steer and m/s of ground speed
  yawAssistMaxSpeed: 16,       // m/s; the turn-in assist fades out between half and this speed
  uprightAssist: 0.35,         // righting torque, as a fraction of weight × sin(roll), with no gyros fitted
  uprightAssistPerGyro: 0.45,  // extra righting per gyro stabilizer bolted on
};

const STEER_MARGIN = 0.3;      // m a wheel must sit ahead of the centre of mass to steer
const PAIR_DISTANCE = 0.35;    // m: a left and a right wheel this close front-to-back share an anti-roll bar
const RIDE_HEIGHT_RATE = 0.2;  // m/s the adjustable suspension rises or falls
const INPUT_THRESHOLD = 0.1;
const SPAWN_CLEARANCE = 0.3;   // m the vehicle drops onto the ground at spawn
const FLIP_MAX_SPEED = 6;      // m/s; flipping upright only works when nearly stopped
const FLIP_LIFT = 1.6;         // m
const UPRIGHT_MIN_SPEED = 5;   // m/s; below this the upright assist leaves the body alone
const UPRIGHT_ROLL_SINE = 0.3; // sin of the roll angle where the assist wakes up (~17°)
const MAX_GYROS = 3;           // more gyro stabilizers than this add nothing
const PAD_SURGE_WATTS = 120000; // a surge pad refills each capacitor at this rate
const PAD_BATTERY_WATTS = 30000; // and trickles the batteries too
const GRAVITY = 9.81;
const AIR_DENSITY = 1.2;       // kg/m³
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
  surge: (placement, name) => new Capacitor(name, placement.model, vector(placement.position), placement.mountId),
  ballast: (placement, name) => new Ballast(name, placement.model, vector(placement.position), placement.mountId),
  gyro: (placement, name) => new Gyro(name, placement.model, vector(placement.position), placement.mountId),
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
  antiRollScale = 1;          // the design's anti-roll dial, multiplied into the bars' stiffness
  simpleDrive = false;        // assisted driving: smoother, stabler, no wheelspin (the design's drive mode)
  steeringLineZ = 0;          // chassis-local z of the line the steering wheels turn about (the back axle)
  rotorsDeployed = false;
  boostActive = false;        // boost held, capacitors in the build, and charge or power to back it
  steerAngle = 0;
  tyreGripAverage = 1;        // mean model grip, the fallback estimate for grip-scaled steering
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
    for (const part of this.parts) {
      if (typeof part.size === 'function') this.chassis.attachBox(world, part.size(), part.mountPoint);
    }
    this.batteryPack = new BatteryPack(this.batteries());
    this.assignSteering(centerOfMass);
    this.assignAlignment();
    this.applyTuning();
    this.antiRollPairs = pairWheels(this.wheels());
    const wheelModels = this.wheels().map(wheel => wheel.model.grip);
    if (wheelModels.length) this.tyreGripAverage = wheelModels.reduce((sum, grip) => sum + grip, 0) / wheelModels.length;
  }

  wheels() { return this.parts.filter(part => part instanceof Wheel); }
  batteries() { return this.parts.filter(part => part instanceof Battery); }
  rotors() { return this.parts.filter(part => part instanceof Rotor); }
  capacitors() { return this.parts.filter(part => part instanceof Capacitor); }
  gyros() { return this.parts.filter(part => part instanceof Gyro); }

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
    if (grounded && !this.rotorsDeployed) {
      this.applyYawAssist(dt);
      this.applyUprightAssist();
    }

    // With the rotors out, the triggers fly instead of drive.
    const throttle = this.rotorsDeployed ? 0 : controls.value('throttle');
    const boost = this.rotorsDeployed ? 0 : controls.value('boost');
    this.drivetrain.update(throttle, controls.value('brake'), this.chassis.forwardSpeed(), boost, dt);
    this.batteryPack.beginStep();
    const capacitors = this.capacitors();
    for (const capacitor of capacitors) capacitor.beginStep();

    // Rotors get first call on the power: staying in the air matters more than the wheels.
    for (const rotor of rotors) rotor.deployTowards(this.rotorsDeployed, dt);
    if (rotors.length > 0 && rotors.every(rotor => rotor.deployed())) {
      this.flightController.fly(this.chassis, rotors, controls, grounded, track, dt);
    } else {
      this.flightController.disengage();
      for (const rotor of rotors) rotor.command(0);
    }
    const rotorShare = this.batteryPack.request(rotors.reduce((sum, rotor) => sum + rotor.powerDemand(), 0));
    // Flying wastes most of its watts as heat: the drain is a multiple of what the rotors were granted,
    // so hover time is short and acro climbs are ruinous, while thrust and hover ability are untouched.
    this.batteryPack.auxiliaryWatts = rotors.reduce((sum, rotor) => sum + rotor.powerDemand(), 0)
      * rotorShare * (rotorTuning.flightDrain - 1);
    for (const rotor of rotors) rotor.limitPower(rotorShare);

    // Then the hub motors share what is left, topped up by the surge capacitors while boost is held.
    const requests = wheels.map(wheel => this.drivetrain.motorRequest(wheel));
    const wheelDemand = wheels.reduce((sum, wheel, index) => sum + wheel.motorPower(requests[index]), 0);
    let wheelShare = this.batteryPack.request(wheelDemand);
    this.boostActive = false;
    if (boost > 0.5 && wheelDemand > 0 && capacitors.length > 0) {
      const surgeWatts = capacitors.reduce((sum, capacitor) => sum + capacitor.availableSurge(), 0);
      const granted = Math.min(wheelDemand * (1 - wheelShare), surgeWatts);
      if (granted > 0) {
        for (const capacitor of capacitors) capacitor.deliver(capacitor.availableSurge() * (granted / surgeWatts), dt);
        wheelShare = Math.min(1, wheelShare + granted / wheelDemand);
      }
      this.boostActive = capacitors.some(capacitor => capacitor.charge > 0);
    } else if (capacitors.length > 0 && this.batteryPack.charge() > 0) {
      // Off boost, the capacitors trickle themselves full from whatever the batteries can spare.
      const rechargeDemand = capacitors.reduce((sum, capacitor) => sum + capacitor.rechargeDemand(), 0);
      const rechargeShare = this.batteryPack.request(rechargeDemand);
      if (rechargeShare > 0) for (const capacitor of capacitors) capacitor.chargeWith(capacitor.rechargeDemand() * rechargeShare, dt);
    }
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
      this.chassis.applyAirYaw(controls.value('steer'));
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
    this.boostActive = false;
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
  boosting() { return this.boostActive; }
  hasRotors() { return this.rotors().length > 0; }
  hasSurge() { return this.capacitors().length > 0; }
  mountSurfaces() { return this.chassis.mountSurfaces(); }
  partVisuals() { return this.parts.map(part => part.visual); }
  showPanels(visible) { this.chassis.bodywork.showPanels(visible); }
  wheelReadouts() { return this.wheels().map(wheel => wheel.readout()); }
  appliedForces() { return this.parts.flatMap(part => part.forces()); }

  /**
   * Where dust and sparks should billow: each tyre on loose ground or sliding, plus the capacitors
   * crackling while boost is live. One source per wheel: { point, color, intensity, spark, velocity }.
   */
  dustSources() {
    const sources = [];
    const speed = this.chassis.speed();
    const velocity = this.chassis.linearVelocity();
    for (const wheel of this.wheels()) {
      const contact = wheel.contact();
      if (!contact) continue;
      const intensity = contact.surface.loose
        ? THREE.MathUtils.clamp(speed / 14, 0, 1) + (contact.sliding ? 0.4 : 0)
        : (contact.sliding ? 0.7 : (speed > 20 ? 0.25 : 0));
      if (intensity < 0.05) continue;
      sources.push({ point: contact.point, color: contact.surface.color, intensity, spark: false, velocity });
    }
    if (this.boostActive) {
      for (const capacitor of this.capacitors()) {
        sources.push({
          point: this.chassis.toWorld(capacitor.mountPoint.clone()),
          color: 0x7fe8ff, intensity: 0.8, spark: true, velocity,
        });
      }
    }
    return sources;
  }

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

  /** Applies the design's toe and camber: the steering axle gets the front settings, the rest the rear. */
  assignAlignment() {
    for (const wheel of this.wheels()) {
      const end = wheel.steers() ? 'front' : 'rear';
      wheel.setAlignment(this.blueprint.alignment[`${end}Toe`], this.blueprint.alignment[`${end}Camber`]);
    }
  }

  /** Wires the design's handling dials and control setups into the drivetrain, springs, bars and flight brain. */
  applyTuning() {
    const tuning = this.blueprint.tuning;
    this.drivetrain.torqueSplit = tuning.torqueSplit;
    this.drivetrain.brakeBias = tuning.brakeBias;
    this.antiRollScale = tuning.antiRoll;
    this.batteryPack.regenFraction = tuning.regen;
    this.simpleDrive = this.blueprint.controls.drive === 'simple';
    this.drivetrain.assists = this.simpleDrive;
    this.flightController.mode = this.blueprint.controls.flight;
    for (const wheel of this.wheels()) {
      wheel.setSpringScale(tuning.springRate);
      wheel.tractionAssist = this.simpleDrive;
      wheel.fitSuspension(wheel.restingLoad, this.currentRideHeight);
    }
  }

  /**
   * A gentle righting hand once the body leans too far at speed: every build gets a little, and each
   * gyro stabilizer makes it much stronger. Positive torque about the nose pushes a raised side down.
   */
  applyUprightAssist() {
    const speed = this.chassis.speed();
    if (speed < UPRIGHT_MIN_SPEED) return;
    const roll = this.chassis.right().y;
    const threshold = this.simpleDrive ? 0.15 : UPRIGHT_ROLL_SINE;
    if (Math.abs(roll) < threshold) return;
    const strength = handlingTuning.uprightAssist
      + Math.min(this.gyros().length, MAX_GYROS) * handlingTuning.uprightAssistPerGyro;
    const assist = strength * (this.simpleDrive ? 1.6 : 1);
    const torque = this.chassis.forward().multiplyScalar(roll * this.chassis.mass() * GRAVITY * assist);
    this.chassis.twist(torque);
  }

  /** A surge pad on the track pours charge into the capacitors, and a little into the batteries. */
  chargeFromPad(dt) {
    for (const capacitor of this.capacitors()) capacitor.chargeWith(PAD_SURGE_WATTS, dt);
    this.batteryPack.topUp((PAD_BATTERY_WATTS * dt) / 3600);
  }

  /** Eases the wheels toward the target, capped by what the tyres can grip, and points each at one turning centre. */
  steer(input, wheels, dt) {
    const steering = wheels.filter(wheel => wheel.steers());
    if (steering.length === 0) return;
    const reach = Math.max(...steering.map(wheel => this.steeringLineZ - wheel.hubZ()), 0.1);
    const speed = Math.max(Math.abs(this.chassis.forwardSpeed()), 0.1);
    const maxAngle = Math.min(
      THREE.MathUtils.degToRad(handlingTuning.maxSteerDegrees),
      this.gripLimitedSteerAngle(speed, reach, wheels),
    );
    const maxChange = handlingTuning.steerSpeed * dt;
    this.steerAngle += THREE.MathUtils.clamp(input * maxAngle - this.steerAngle, -maxChange, maxChange);

    for (const wheel of steering) {
      wheel.setSteerAngle(ackermannAngle(this.steerAngle, reach, this.steeringLineZ - wheel.hubZ(), wheel.hubX()));
    }
  }

  /**
   * The widest steer that still asks the tyres for no more than about their cornering grip, so the front
   * never demands an impossible turn and plows (the old boat). Aero downforce counts: at speed, wings
   * and splitters hold the car harder into the turn, so the steering stays generous — the F-Zero trick.
   */
  gripLimitedSteerAngle(speed, reach, wheels) {
    const gripping = wheels.filter(wheel => wheel.touchingGround());
    const grip = gripping.length
      ? gripping.reduce((sum, wheel) => sum + wheel.gripEstimate(), 0) / gripping.length
      : this.tyreGripAverage;
    const aeroDownforce = 0.5 * AIR_DENSITY * speed * speed * this.chassis.downforceArea();
    const aeroGrip = (aeroDownforce / this.chassis.mass()) * grip;
    // Assisted driving never asks the tyres for more than they have; advanced leaves a margin to play with.
    const margin = this.simpleDrive ? 0.95 : handlingTuning.steerGripMargin;
    const lateralAccel = GRAVITY * grip * margin + aeroGrip;
    return Math.atan2(lateralAccel * reach, speed * speed);
  }

  /** A little extra turn-in at low and middling speeds, where big builds feel laziest. */
  applyYawAssist(dt) {
    const speed = Math.abs(this.chassis.forwardSpeed());
    if (speed < 1) return;
    const fade = this.simpleDrive
      ? 2 // assisted driving keeps the full turn-in help at every speed
      : 1 - THREE.MathUtils.clamp((speed - handlingTuning.yawAssistMaxSpeed / 2) / (handlingTuning.yawAssistMaxSpeed / 2), 0, 1);
    if (fade <= 0) return;
    const torque = this.steerAngle * Math.min(speed, handlingTuning.yawAssistMaxSpeed)
      * handlingTuning.yawAssistTorque * fade;
    this.chassis.twist(this.chassis.up().multiplyScalar(-torque));
  }

  /** Each left–right pair's anti-roll bar moves load from the more compressed wheel to the other, resisting lean. */
  applyAntiRoll() {
    for (const [left, right] of this.antiRollPairs) {
      if (!left.touchingGround() || !right.touchingGround()) continue;
      const transfer = (left.compressionAmount() - right.compressionAmount())
        * handlingTuning.antiRollStiffness * this.antiRollScale;
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
