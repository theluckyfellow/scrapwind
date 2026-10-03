import * as THREE from 'three';
import { Part } from './Part.js';
import { toonMesh, toonMaterial } from './toon.js';

export const rotorTuning = {
  maxThrust: 4300,          // N per rotor; four lift about 2.7× the buggy's weight
  yawTorquePerThrust: 1.0,  // N·m of twist per N of thrust (blade drag); how the rotors turn the buggy.
                            // About ten times a real drone's, so turning feels responsive.
  deploySeconds: 0.6,
  spinUpRate: 7,            // 1/s, how quickly thrust follows its command (motor lag)
  deployedDragArea: 2.4,    // m² of extra drag with all four rotors out; caps flying speed
};

const ARM_LENGTH = 0.95;
const STOWED_SPLAY = THREE.MathUtils.degToRad(30); // folded arms angle out a little so the two fans don't overlap
const BLADE_RADIUS = 0.72;
const IDLE_BLADE_SPEED = 20;  // rad/s, visual
const FULL_BLADE_SPEED = 95;  // rad/s, visual
const MIN_PUSH = 1;           // N; below this the rotor isn't worth a force call
const LOCAL_UP = new THREE.Vector3(0, 1, 0);

const ARM_COLOR = 0x3a3f44;
const MOTOR_COLOR = 0x8a9496;
const BLADE_COLOR = 0xeae3d2;
const GUARD_COLOR = 0x3f8f8a;

/**
 * Rotor: one fold-out quadcopter fan on an arm that swings out from the chassis.
 * Thrust pushes the Chassis along its up axis at the hub; spinning blades also twist it, which is how
 * the FlightController turns the buggy. Vehicle deploys and stows it; the FlightController commands its thrust.
 */
export class Rotor extends Part {
  pivotPoint;
  stowedSwing;               // radians the arm swings in to lie along the body when stowed
  spinDirection;             // +1 or -1; diagonal pairs match so their twists cancel at equal thrust
  deployAmount = 0;          // 0 stowed .. 1 out and ready
  thrustCommand = 0;         // N
  thrust = 0;                // N actually produced, lagging the command
  bladeAngle = 0;
  foldGroup = new THREE.Group();
  bladeGroup = new THREE.Group();

  constructor(name, pivotPoint, outwardDirection, spinDirection) {
    const outward = outwardDirection.clone().setY(0).normalize();
    const yaw = Math.atan2(-outward.z, outward.x);
    const hub = pivotPoint.clone().add(new THREE.Vector3(ARM_LENGTH, 0, 0).applyAxisAngle(LOCAL_UP, yaw));
    super(name, hub);
    this.pivotPoint = pivotPoint.clone();
    // Stowed, the arm lies along the body like a folding drone's: front arms point forward, rear arms back.
    const alongBodyYaw = (pivotPoint.z < 0 ? Math.PI / 2 : -Math.PI / 2)
      + Math.sign(pivotPoint.x) * Math.sign(pivotPoint.z) * STOWED_SPLAY;
    this.stowedSwing = Math.atan2(Math.sin(alongBodyYaw - yaw), Math.cos(alongBodyYaw - yaw));
    this.spinDirection = spinDirection;
    this.visual.position.copy(pivotPoint);
    this.visual.rotation.y = yaw;
    this.buildVisual();
  }

  deployed() { return this.deployAmount >= 1; }
  spinSign() { return this.spinDirection; }

  /** The hub's position relative to the centre of mass, chassis-local; the FlightController's lever arm. */
  leverArm(localCenterOfMass, target = new THREE.Vector3()) {
    return target.copy(this.mountPoint).sub(localCenterOfMass);
  }

  /** Unfolds (true) or folds (false) the arm a little more each step. */
  deployTowards(wantDeployed, dt) {
    const change = dt / rotorTuning.deploySeconds;
    this.deployAmount = THREE.MathUtils.clamp(this.deployAmount + (wantDeployed ? change : -change), 0, 1);
  }

  /** Asks for a thrust in newtons; clamped to what the motor can do. */
  command(thrust) {
    this.thrustCommand = THREE.MathUtils.clamp(thrust, 0, rotorTuning.maxThrust);
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

  /** This rotor's share of extra drag while it is out. */
  dragArea() {
    return this.deployAmount * rotorTuning.deployedDragArea / 4;
  }

  updateVisual(frameSeconds) {
    const eased = this.deployAmount * this.deployAmount * (3 - 2 * this.deployAmount);
    this.foldGroup.rotation.y = THREE.MathUtils.lerp(this.stowedSwing, 0, eased);
    const throttle = this.thrust / rotorTuning.maxThrust;
    const bladeSpeed = this.deployed() ? THREE.MathUtils.lerp(IDLE_BLADE_SPEED, FULL_BLADE_SPEED, throttle) : 0;
    this.bladeAngle = (this.bladeAngle + bladeSpeed * this.spinDirection * frameSeconds) % (Math.PI * 2);
    this.bladeGroup.rotation.y = this.bladeAngle;
  }

  reset() {
    super.reset();
    this.deployAmount = 0;
    this.thrustCommand = 0;
    this.thrust = 0;
  }

  buildVisual() {
    const arm = toonMesh(new THREE.BoxGeometry(ARM_LENGTH, 0.1, 0.1), ARM_COLOR, { outline: 0.02 });
    arm.position.x = ARM_LENGTH / 2;
    this.foldGroup.add(arm);

    const motor = toonMesh(new THREE.CylinderGeometry(0.13, 0.15, 0.22, 8), MOTOR_COLOR, { outline: 0.02 });
    motor.position.set(ARM_LENGTH, 0.06, 0);
    this.foldGroup.add(motor);

    const guard = toonMesh(new THREE.TorusGeometry(BLADE_RADIUS + 0.06, 0.045, 5, 20), GUARD_COLOR, { outline: 0.015 });
    guard.rotation.x = Math.PI / 2;
    guard.position.set(ARM_LENGTH, 0.16, 0);
    this.foldGroup.add(guard);

    const bladeMaterial = toonMaterial(BLADE_COLOR);
    for (const angle of [0, Math.PI / 2]) {
      const blade = toonMesh(new THREE.BoxGeometry(BLADE_RADIUS * 2, 0.03, 0.12), null, { material: bladeMaterial, outline: 0.012 });
      blade.rotation.y = angle;
      this.bladeGroup.add(blade);
    }
    this.bladeGroup.position.set(ARM_LENGTH, 0.19, 0);
    this.foldGroup.add(this.bladeGroup);

    this.visual.add(this.foldGroup);
  }
}
