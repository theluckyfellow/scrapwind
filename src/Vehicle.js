import * as THREE from 'three';
import { Chassis } from './Chassis.js';
import { Wheel } from './Wheel.js';
import { Rotor } from './Rotor.js';
import { Drivetrain, drivetrainTuning } from './Drivetrain.js';
import { FlightController } from './FlightController.js';

export const handlingTuning = {
  maxSteerDegrees: 32,
  highSpeedSteerDegrees: 9,    // steering narrows to this at speed, so the stick stays usable
  steerFalloffSpeed: 32,       // m/s where steering has narrowed fully
  steerSpeed: 3.2,             // rad/s the front wheels can turn
  antiRollStiffness: 7000,     // N/m per axle resisting body roll
};

// Chassis-local layout. Forward is −Z, right is +X, up is +Y.
const WHEEL_LAYOUT = [
  { name: 'Front left', mount: [-1.1, -0.05, -1.35], isFront: true, isLeft: true },
  { name: 'Front right', mount: [1.1, -0.05, -1.35], isFront: true, isLeft: false },
  { name: 'Rear left', mount: [-1.1, -0.05, 1.35], isFront: false, isLeft: true },
  { name: 'Rear right', mount: [1.1, -0.05, 1.35], isFront: false, isLeft: false },
];
const ROTOR_LAYOUT = [
  { name: 'Front left rotor', pivot: [-0.75, 0.55, -1.2], outward: [-1, 0, -0.8], spin: 1 },
  { name: 'Front right rotor', pivot: [0.75, 0.55, -1.2], outward: [1, 0, -0.8], spin: -1 },
  { name: 'Rear left rotor', pivot: [-0.75, 0.55, 1.2], outward: [-1, 0, 0.8], spin: -1 },
  { name: 'Rear right rotor', pivot: [0.75, 0.55, 1.2], outward: [1, 0, 0.8], spin: 1 },
];
const WHEELBASE = 2.7;      // m between front and rear mounts
const TRACK_WIDTH = 2.2;    // m between left and right mounts
const FLIP_MAX_SPEED = 6;   // m/s; flipping upright only works when nearly stopped
const FLIP_LIFT = 1.6;      // m
const LOCAL_UP = new THREE.Vector3(0, 1, 0);

/**
 * Vehicle: a scrap buggy. A Chassis with Parts bolted on (four Wheels, four Rotors), a Drivetrain
 * turning the wheels and a FlightController flying the rotors.
 * Game steps it with Controls each physics step; ChaseCamera and Telemetry read it through methods.
 */
export class Vehicle {
  chassis;
  parts = [];
  drivetrain = new Drivetrain();
  flightController = new FlightController();
  rotorsDeployed = false;
  steerAngle = 0;
  spawnPosition;
  spawnQuaternion;

  constructor(world, spawnPosition, spawnHeading) {
    this.spawnPosition = spawnPosition.clone();
    this.spawnQuaternion = new THREE.Quaternion().setFromAxisAngle(LOCAL_UP, spawnHeading);
    this.chassis = new Chassis(world, this.spawnPosition, this.spawnQuaternion);

    for (const layout of WHEEL_LAYOUT) {
      this.parts.push(new Wheel(layout.name, new THREE.Vector3(...layout.mount), layout.isFront, layout.isLeft));
    }
    for (const layout of ROTOR_LAYOUT) {
      this.parts.push(new Rotor(layout.name, new THREE.Vector3(...layout.pivot), new THREE.Vector3(...layout.outward), layout.spin));
    }
    for (const part of this.parts) this.chassis.visual.add(part.visual);
  }

  wheels() { return this.parts.filter(part => part instanceof Wheel); }
  rotors() { return this.parts.filter(part => part instanceof Rotor); }

  /** The root of everything drawn for this vehicle. */
  visual() { return this.chassis.visual; }

  /** Runs one physics step: suspension, drive, tyres, rotors and air, in that order. */
  step(controls, track, dt) {
    this.chassis.beginStep();
    for (const part of this.parts) part.clearForces();
    const wheels = this.wheels();
    const rotors = this.rotors();

    this.steer(controls.value('steer'), wheels, dt);
    for (const wheel of wheels) wheel.sense(this.chassis, track, dt);
    this.applyAntiRoll(wheels);
    const grounded = wheels.some(wheel => wheel.touchingGround());

    // With the rotors out, the triggers fly instead of drive.
    const throttle = this.rotorsDeployed ? 0 : controls.value('throttle');
    const averageSpin = wheels.reduce((sum, wheel) => sum + wheel.spin(), 0) / wheels.length;
    this.drivetrain.update(throttle, controls.value('brake'), this.chassis.forwardSpeed(), averageSpin, dt);
    const handbrake = controls.value('handbrake') > 0.5 ? drivetrainTuning.handbrakeForce : 0;
    for (const wheel of wheels) {
      const front = wheel.front();
      wheel.grip(this.chassis, track, this.drivetrain.wheelTorque(front), this.drivetrain.brakeForce(front), front ? 0 : handbrake, dt);
    }

    for (const rotor of rotors) rotor.deployTowards(this.rotorsDeployed, dt);
    if (rotors.every(rotor => rotor.deployed())) {
      this.flightController.fly(this.chassis, rotors, controls, grounded, track);
    } else {
      this.flightController.disengage();
      for (const rotor of rotors) rotor.command(0);
    }
    for (const rotor of rotors) rotor.spin(this.chassis, dt);

    this.chassis.applyDrag(rotors.reduce((sum, rotor) => sum + rotor.dragArea(), 0));
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

  toggleRotors() {
    this.rotorsDeployed = !this.rotorsDeployed;
  }

  /** Re-reads the chassis mass tuning after the tuning panel changes it. */
  applyMassTuning() {
    this.chassis.applyMassTuning();
  }

  /** Sets the buggy back on its wheels, facing the way it was, if it is nearly stopped. */
  flipUpright() {
    if (this.chassis.speed() > FLIP_MAX_SPEED) return;
    const forward = this.chassis.forward().setY(0);
    if (forward.lengthSq() < 1e-4) forward.set(0, 0, -1);
    const heading = Math.atan2(-forward.x, -forward.z);
    const position = this.chassis.drawnPosition().add(new THREE.Vector3(0, FLIP_LIFT, 0));
    this.chassis.placeAt(position, new THREE.Quaternion().setFromAxisAngle(LOCAL_UP, heading));
    for (const wheel of this.wheels()) wheel.reset();
  }

  /** Back to the start line, as good as new. */
  reset() {
    this.chassis.placeAt(this.spawnPosition, this.spawnQuaternion);
    for (const part of this.parts) part.reset();
    this.drivetrain.reset();
    this.flightController.reset();
    this.rotorsDeployed = false;
    this.steerAngle = 0;
  }

  speed() { return this.chassis.speed(); }
  altitude() { return this.chassis.drawnPosition().y; }
  drawnPosition(target) { return this.chassis.drawnPosition(target); }
  drawnQuaternion(target) { return this.chassis.drawnQuaternion(target); }
  gearLabel() { return this.drivetrain.gearLabel(); }
  rpmFraction() { return this.drivetrain.rpmFraction(); }
  flying() { return this.rotorsDeployed; }
  wheelReadouts() { return this.wheels().map(wheel => wheel.readout()); }
  appliedForces() { return this.parts.flatMap(part => part.forces()); }

  /** Narrows steering with speed, eases the wheels toward the target and applies Ackermann geometry. */
  steer(input, wheels, dt) {
    const narrowing = THREE.MathUtils.clamp(Math.abs(this.chassis.forwardSpeed()) / handlingTuning.steerFalloffSpeed, 0, 1);
    const maxAngle = THREE.MathUtils.degToRad(
      THREE.MathUtils.lerp(handlingTuning.maxSteerDegrees, handlingTuning.highSpeedSteerDegrees, narrowing),
    );
    const maxChange = handlingTuning.steerSpeed * dt;
    this.steerAngle += THREE.MathUtils.clamp(input * maxAngle - this.steerAngle, -maxChange, maxChange);
    for (const wheel of wheels) {
      if (wheel.front()) wheel.setSteerAngle(ackermannAngle(this.steerAngle, wheel.left()));
    }
  }

  /** Each axle's anti-roll bar moves load from the more compressed wheel to the other, resisting lean. */
  applyAntiRoll(wheels) {
    for (const isFront of [true, false]) {
      const left = wheels.find(wheel => wheel.front() === isFront && wheel.left());
      const right = wheels.find(wheel => wheel.front() === isFront && !wheel.left());
      if (!left.touchingGround() || !right.touchingGround()) continue;
      const transfer = (left.compressionAmount() - right.compressionAmount()) * handlingTuning.antiRollStiffness;
      left.shareLoad(this.chassis, transfer);
      right.shareLoad(this.chassis, -transfer);
    }
  }
}

/**
 * Ackermann steering: the inside front wheel turns tighter than the outside one, so both roll around
 * the same turning centre instead of scrubbing. steerAngle is the average angle; positive steers right.
 */
function ackermannAngle(steerAngle, isLeft) {
  if (Math.abs(steerAngle) < 1e-4) return steerAngle;
  const turnRadius = WHEELBASE / Math.tan(Math.abs(steerAngle));
  const turningRight = steerAngle > 0;
  const inside = turningRight !== isLeft;
  const offset = inside ? -TRACK_WIDTH / 2 : TRACK_WIDTH / 2;
  return Math.sign(steerAngle) * Math.atan(WHEELBASE / (turnRadius + offset));
}
