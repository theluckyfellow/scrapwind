import * as THREE from 'three';
import { Part } from './Part.js';
import { toonMesh } from './toon.js';
import { rotorOutward, rotorHubPosition } from './catalog.js';

export const rotorTuning = {
  yawTorquePerThrust: 1.0,  // N·m of twist per N of thrust (blade drag); how the rotors turn the vehicle.
                            // About ten times a real drone's, so turning feels responsive.
  deploySeconds: 0.9,       // arm swings out in the first half, blades unfold in the second
  spinUpRate: 7,            // 1/s, how quickly thrust follows its command (motor lag)
  dragAreaPerRotor: 0.6,    // m² of extra drag per deployed rotor; caps flying speed
  powerScale: 0.5,          // multiplies the ideal-rotor power draw; lower means longer flights
};

const AIR_DENSITY = 1.2;
const STOWED_SPLAY = THREE.MathUtils.degToRad(20); // stowed arms angle out a little from the body
const BLADE_FOLD_GAP = 0.09;  // radians between the two folded blades
const BLADE_PITCH = 0.12;     // radians of twist, for the look
const IDLE_BLADE_SPEED = 20;  // rad/s, visual
const FULL_BLADE_SPEED = 95;  // rad/s, visual
const BLADE_PARK_RATE = 10;   // 1/s, how quickly stopping blades swing back in line to fold
const MIN_PUSH = 1;           // N; below this the rotor isn't worth a force call

const ARM_COLOR = 0x3a3f44;
const MOTOR_COLOR = 0x8a9496;
const BLADE_COLOR = 0xeae3d2;

/** Electrical power (W) a rotor of this model draws to make a thrust: ideal momentum theory, scaled. */
export function rotorPower(model, thrust) {
  const discArea = Math.PI * model.bladeRadius * model.bladeRadius;
  return (Math.pow(Math.max(thrust, 0), 1.5) / Math.sqrt(2 * AIR_DENSITY * discArea)) * rotorTuning.powerScale;
}

/**
 * Rotor: a two-blade prop on an arm that swings out from the frame. No guard: stowed, the blades fold
 * together and tuck in along the arm, and the arm lies alongside the body.
 * Thrust pushes the Chassis along its up axis at the hub; spinning blades also twist it, which is how the
 * FlightController turns the vehicle. Vehicle deploys and stows it and runs its power past the BatteryPack.
 */
export class Rotor extends Part {
  model;
  pivotPoint;
  stowedSwing;               // radians the arm swings in to lie along the body
  spinDirection;             // +1 or −1; diagonal pairs match so their twists cancel at equal thrust
  deployAmount = 0;          // 0 stowed .. 1 out and ready
  thrustCommand = 0;         // N
  thrust = 0;                // N actually produced, lagging the command
  bladeAngle = 0;
  swingGroup = new THREE.Group();
  bladeHub = new THREE.Group();
  blades = [];

  constructor(name, model, pivotPoint, spinDirection, mountId) {
    const pivot = pivotPoint.toArray();
    super(name, new THREE.Vector3(...rotorHubPosition(model, pivot)), mountId);
    this.model = model;
    this.pivotPoint = pivotPoint.clone();
    this.spinDirection = spinDirection;

    const outward = rotorOutward(pivot);
    const yaw = Math.atan2(-outward[2], outward[0]);
    // Stowed, the arm lies along the body: front arms point forward, rear arms back, splayed out a touch.
    const alongBody = (pivot[2] <= 0 ? Math.PI / 2 : -Math.PI / 2) + Math.sign(pivot[0] * pivot[2]) * STOWED_SPLAY;
    this.stowedSwing = Math.atan2(Math.sin(alongBody - yaw), Math.cos(alongBody - yaw));

    this.visual.position.copy(pivotPoint);
    this.visual.rotation.y = yaw;
    this.buildVisual();
  }

  deployed() { return this.deployAmount >= 1; }
  spinSign() { return this.spinDirection; }
  maxThrust() { return this.model.maxThrust; }

  /** The hub's position relative to the centre of mass, chassis-local; the FlightController's lever arm. */
  leverArm(localCenterOfMass, target = new THREE.Vector3()) {
    return target.copy(this.mountPoint).sub(localCenterOfMass);
  }

  /** Unfolds (true) or folds (false) a little more each step. */
  deployTowards(wantDeployed, dt) {
    const change = dt / rotorTuning.deploySeconds;
    this.deployAmount = THREE.MathUtils.clamp(this.deployAmount + (wantDeployed ? change : -change), 0, 1);
  }

  /** Snaps fully out or fully in, for the garage preview. */
  setDeployed(deployed) {
    this.deployAmount = deployed ? 1 : 0;
  }

  /** Asks for a thrust in newtons; clamped to what the motor can do. */
  command(thrust) {
    this.thrustCommand = THREE.MathUtils.clamp(thrust, 0, this.model.maxThrust);
  }

  /** Watts this rotor needs for its current command. */
  powerDemand() {
    return this.deployed() ? rotorPower(this.model, this.thrustCommand) : 0;
  }

  /** Cuts the command when the batteries can only grant a fraction of the power (thrust goes as power^⅔). */
  limitPower(fraction) {
    if (fraction < 1) this.thrustCommand *= Math.cbrt(fraction * fraction);
  }

  /** Spins the motor toward its command and pushes and twists the chassis with the result. */
  spin(chassis, dt) {
    const target = this.deployed() ? this.thrustCommand : 0;
    this.thrust += (target - this.thrust) * (1 - Math.exp(-rotorTuning.spinUpRate * dt));
    if (this.thrust < MIN_PUSH) return;

    const up = chassis.up();
    this.push(chassis, up.clone().multiplyScalar(this.thrust), chassis.toWorld(this.mountPoint), 'thrust');
    chassis.twist(up.multiplyScalar(-this.spinDirection * rotorTuning.yawTorquePerThrust * this.thrust));
  }

  /** This rotor's extra drag while it is out. */
  dragArea() {
    return this.deployAmount * rotorTuning.dragAreaPerRotor;
  }

  updateVisual(frameSeconds) {
    const swing = smoothstep(THREE.MathUtils.clamp(this.deployAmount * 2, 0, 1));
    const unfold = smoothstep(THREE.MathUtils.clamp(this.deployAmount * 2 - 1, 0, 1));
    this.swingGroup.rotation.y = THREE.MathUtils.lerp(this.stowedSwing, 0, swing);

    // Folded, both blades point back along the arm (−X), side by side; unfolded they sit opposite each other.
    this.blades[0].rotation.y = THREE.MathUtils.lerp(Math.PI - BLADE_FOLD_GAP, 0, unfold);
    this.blades[1].rotation.y = THREE.MathUtils.lerp(Math.PI + BLADE_FOLD_GAP, Math.PI, unfold);

    if (this.deployed()) {
      const throttle = this.thrust / this.model.maxThrust;
      const speed = THREE.MathUtils.lerp(IDLE_BLADE_SPEED, FULL_BLADE_SPEED, throttle);
      this.bladeAngle = (this.bladeAngle + speed * this.spinDirection * frameSeconds) % (Math.PI * 2);
    } else {
      // Blades swing back in line with the arm before folding.
      const wrapped = Math.atan2(Math.sin(this.bladeAngle), Math.cos(this.bladeAngle));
      this.bladeAngle = wrapped * Math.exp(-BLADE_PARK_RATE * frameSeconds);
    }
    this.bladeHub.rotation.y = this.bladeAngle;
  }

  reset() {
    super.reset();
    this.deployAmount = 0;
    this.thrustCommand = 0;
    this.thrust = 0;
    this.bladeAngle = 0;
  }

  buildVisual() {
    const { armLength, bladeRadius } = this.model;
    const arm = toonMesh(new THREE.BoxGeometry(armLength, 0.09, 0.09), ARM_COLOR, { outline: 0.018 });
    arm.position.x = armLength / 2;
    this.swingGroup.add(arm);

    const motor = toonMesh(new THREE.CylinderGeometry(0.11, 0.13, 0.2, 8), MOTOR_COLOR, { outline: 0.018 });
    motor.position.set(armLength, 0.06, 0);
    this.swingGroup.add(motor);

    const bladeGeometry = new THREE.BoxGeometry(bladeRadius, 0.025, 0.11).translate(bladeRadius / 2, 0, 0);
    for (let index = 0; index < 2; index++) {
      const pitch = new THREE.Group();
      pitch.rotation.x = index === 0 ? BLADE_PITCH : -BLADE_PITCH;
      pitch.add(toonMesh(bladeGeometry, BLADE_COLOR, { outline: 0.012 }));
      const hinge = new THREE.Group();
      hinge.add(pitch);
      this.blades.push(hinge);
      this.bladeHub.add(hinge);
    }
    this.bladeHub.position.set(armLength, 0.18, 0);
    this.swingGroup.add(this.bladeHub);

    this.visual.add(this.swingGroup);
  }
}

function smoothstep(value) {
  return value * value * (3 - 2 * value);
}
