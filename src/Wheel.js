import * as THREE from 'three';
import { Part } from './Part.js';
import { toonMesh } from './toon.js';

export const wheelTuning = {
  restLength: 0.55,           // m of suspension travel from full droop to fully compressed
  springStiffness: 11000,     // N/m
  damping: 1100,              // N per m/s of compression speed
  bumpStopStiffness: 120000,  // N/m once compression passes the bump stop
  tyreGrip: 1.15,             // friction coefficient on a grip-1 surface
  peakSlipDegrees: 8,         // slip angle where sideways grip peaks
  slidingGrip: 0.78,          // fraction of peak sideways grip left at big slip angles (drifting)
  kineticGrip: 0.8,           // fraction of grip left once a tyre is asked for more than it has
  tyreForceLift: 0.35,        // 0 = tyre forces act at the ground, 1 = at the centre of mass; higher resists rollovers
};

const RADIUS = 0.42;
const WIDTH = 0.34;
const GRAVITY = 9.81;
const BUMP_STOP_FRACTION = 0.85;  // of restLength
// Slip-angle maths divides by forward speed; this floor keeps a parked tyre from dividing by zero.
const LOW_SPEED_FLOOR = 1.5;      // m/s
// At low speed a tyre cancels sideways creep directly, but only this much per step, so four tyres don't overshoot together.
const LATERAL_HOLD = 0.5;
// How far past its grip a tyre must be pushed before it is fully on kinetic (sliding) grip.
const OVERLOAD_BLEND = 0.5;
const WHEELSPIN_SURPLUS = 45;     // rad/s of extra spin at full wheelspin
const SPIN_RESPONSE = 14;         // 1/s, how fast a locked or spinning wheel reaches its target spin
const AIR_SPIN_PER_TORQUE = 0.08; // rad/s² of free spin per N·m of drive while airborne (visual only)
const AIR_SPIN_DECAY = 0.6;       // 1/s
const DROOP_RATE = 3;             // m/s the wheel drops when it leaves the ground

const TYRE_COLOR = 0x2a2522;
const HUB_COLOR = 0xd9a441;

/**
 * Wheel: a ray-cast suspension strut and a tyre.
 * sense() finds the ground under it (asking the TestTrack) and pushes the Chassis up with a spring and damper;
 * grip() turns drive, brake and steering into tyre forces, capped by the friction circle.
 * Vehicle steers it and feeds it torque from the Drivetrain.
 */
export class Wheel extends Part {
  isFront;
  isLeft;
  steerAngle = 0;               // radians, positive steers right
  inContact = false;
  compression = 0;              // m; can pass restLength when squashed into the bump stop
  previousCompression = 0;
  springLength = wheelTuning.restLength;
  load = 0;                     // N pressing the tyre into the ground
  ground = null;                // last hit from TestTrack.probeGround
  spinSpeed = 0;                // rad/s, positive rolls forward
  spinAngle = 0;
  slipAngle = 0;                // radians, sideways slip of the tyre
  sliding = false;
  steerGroup = new THREE.Group();
  tyre;

  constructor(name, mountPoint, isFront, isLeft) {
    super(name, mountPoint);
    this.isFront = isFront;
    this.isLeft = isLeft;
    this.buildVisual();
  }

  front() { return this.isFront; }
  left() { return this.isLeft; }
  touchingGround() { return this.inContact; }
  spin() { return this.spinSpeed; }
  compressionAmount() { return this.inContact ? this.compression : 0; }

  /** Sets the steering angle in radians; positive steers right. */
  setSteerAngle(angle) {
    this.steerAngle = angle;
  }

  /** Casts down from the mount to find the ground, then pushes the chassis up with the spring and damper. */
  sense(chassis, track, dt) {
    const mountWorld = chassis.toWorld(this.mountPoint);
    const up = chassis.up();
    const down = up.clone().negate();
    const hit = track.probeGround(mountWorld, down, wheelTuning.restLength + RADIUS, chassis);

    if (!hit) {
      this.leaveGround(dt);
      return;
    }

    const springLength = hit.distance - RADIUS;
    this.compression = wheelTuning.restLength - springLength;
    const compressionSpeed = (this.compression - this.previousCompression) / dt;
    this.previousCompression = this.compression;

    let force = wheelTuning.springStiffness * this.compression + wheelTuning.damping * compressionSpeed;
    const bumpStop = wheelTuning.restLength * BUMP_STOP_FRACTION;
    if (this.compression > bumpStop) {
      force += wheelTuning.bumpStopStiffness * (this.compression - bumpStop);
    }

    this.inContact = true;
    this.ground = hit;
    this.load = Math.max(force, 0);
    this.springLength = THREE.MathUtils.clamp(springLength, 0, wheelTuning.restLength);
    const suspensionForce = up.multiplyScalar(this.load);
    this.push(chassis, suspensionForce, mountWorld, 'suspension');
    track.pushBack(hit, suspensionForce, dt);
  }

  /** Adds (or removes) load, pushing the chassis to match; the anti-roll bar uses this. */
  shareLoad(chassis, extraLoad) {
    if (!this.inContact) return;
    const newLoad = Math.max(this.load + extraLoad, 0);
    const change = newLoad - this.load;
    this.load = newLoad;
    this.push(chassis, chassis.up().multiplyScalar(change), chassis.toWorld(this.mountPoint), 'suspension');
  }

  /**
   * Works out the tyre's push from drive torque, braking and how it is sliding, limited by grip × load.
   * driveTorque in N·m, brakeForce and handbrakeForce in N.
   */
  grip(chassis, track, driveTorque, brakeForce, handbrakeForce, dt) {
    if (!this.inContact) {
      this.sliding = false;
      this.spinInAir(driveTorque, brakeForce + handbrakeForce, dt);
      return;
    }

    const normal = this.ground.normal;
    const grip = wheelTuning.tyreGrip * this.ground.surface.grip;
    const maxForce = grip * this.load;

    // The tyre's own axes, laid flat on the ground it is touching.
    const up = chassis.up();
    const heading = chassis.forward().applyAxisAngle(up, -this.steerAngle);
    heading.addScaledVector(normal, -heading.dot(normal)).normalize();
    const side = new THREE.Vector3().crossVectors(heading, normal);

    const velocity = chassis.velocityAt(this.ground.point);
    const longitudinalSpeed = velocity.dot(heading);
    const lateralSpeed = velocity.dot(side);
    const carriedMass = this.load / GRAVITY;

    // Sideways: the tyre curve at speed, a direct hold against creeping when slow; whichever is gentler.
    this.slipAngle = Math.atan2(lateralSpeed, Math.max(Math.abs(longitudinalSpeed), LOW_SPEED_FLOOR));
    const curveForce = maxForce * lateralGripCurve(this.slipAngle);
    const holdForce = Math.abs(lateralSpeed) * carriedMass / dt * LATERAL_HOLD;
    let lateral = -Math.sign(lateralSpeed) * Math.min(curveForce, holdForce);

    // Along: drive, plus brakes and rolling resistance, which may stop the wheel but never push it backwards.
    const driveForce = driveTorque / RADIUS;
    const stoppingDemand = brakeForce + handbrakeForce + this.ground.surface.rollingResistance * this.load;
    const stoppingForce = Math.min(stoppingDemand, Math.abs(longitudinalSpeed) * carriedMass / dt);
    let longitudinal = driveForce - Math.sign(longitudinalSpeed) * stoppingForce;

    // Friction circle: the tyre has one budget of grip shared between along and sideways.
    const demand = Math.hypot(longitudinal, lateral);
    this.sliding = demand > maxForce;
    let overload = 0;
    if (this.sliding) {
      overload = THREE.MathUtils.clamp((demand / maxForce - 1) / OVERLOAD_BLEND, 0, 1);
      const available = maxForce * THREE.MathUtils.lerp(1, wheelTuning.kineticGrip, overload);
      const scale = available / demand;
      longitudinal *= scale;
      lateral *= scale;
    }

    const force = heading.multiplyScalar(longitudinal).addScaledVector(side, lateral);
    // Lifting the push point toward the centre of mass (along the chassis up axis only, so steering
    // leverage is untouched) trades a little realism for a buggy that doesn't trip over its own tyres.
    const centerOfMass = chassis.worldCenterOfMass();
    const lift = centerOfMass.sub(this.ground.point).dot(up) * wheelTuning.tyreForceLift;
    const point = this.ground.point.clone().addScaledVector(up, lift);
    this.push(chassis, force, point, 'tyre');
    track.pushBack(this.ground, force, dt);

    this.updateSpin(longitudinalSpeed, driveForce, stoppingDemand, overload, dt);
  }

  /** What Telemetry shows for this wheel. */
  readout() {
    return {
      name: this.name,
      inContact: this.inContact,
      load: this.load,
      slipDegrees: THREE.MathUtils.radToDeg(this.slipAngle),
      sliding: this.sliding,
      surface: this.inContact ? this.ground.surface.name : 'air',
    };
  }

  updateVisual(frameSeconds) {
    this.spinAngle = (this.spinAngle + this.spinSpeed * frameSeconds) % (Math.PI * 2);
    this.visual.position.set(this.mountPoint.x, this.mountPoint.y - this.springLength, this.mountPoint.z);
    this.steerGroup.rotation.y = -this.steerAngle;
    this.tyre.rotation.x = -this.spinAngle;
  }

  reset() {
    super.reset();
    this.steerAngle = 0;
    this.inContact = false;
    this.compression = 0;
    this.previousCompression = 0;
    this.springLength = wheelTuning.restLength;
    this.load = 0;
    this.ground = null;
    this.spinSpeed = 0;
    this.slipAngle = 0;
    this.sliding = false;
  }

  leaveGround(dt) {
    this.inContact = false;
    this.ground = null;
    this.load = 0;
    this.compression = 0;
    this.previousCompression = 0;
    this.springLength = Math.min(this.springLength + DROOP_RATE * dt, wheelTuning.restLength);
  }

  updateSpin(longitudinalSpeed, driveForce, stoppingDemand, overload, dt) {
    const rollingSpin = longitudinalSpeed / RADIUS;
    if (!this.sliding) {
      this.spinSpeed = rollingSpin;
      return;
    }
    const braking = stoppingDemand > Math.abs(driveForce);
    const targetSpin = braking ? 0 : rollingSpin + Math.sign(driveForce) * WHEELSPIN_SURPLUS * overload;
    this.spinSpeed += (targetSpin - this.spinSpeed) * (1 - Math.exp(-SPIN_RESPONSE * dt));
  }

  spinInAir(driveTorque, stoppingForce, dt) {
    if (stoppingForce > 0) {
      this.spinSpeed *= Math.exp(-SPIN_RESPONSE * dt);
      return;
    }
    this.spinSpeed += driveTorque * AIR_SPIN_PER_TORQUE * dt;
    this.spinSpeed *= Math.exp(-AIR_SPIN_DECAY * dt);
  }

  buildVisual() {
    const tyreGeometry = new THREE.CylinderGeometry(RADIUS, RADIUS, WIDTH, 14);
    tyreGeometry.rotateZ(Math.PI / 2);
    this.tyre = toonMesh(tyreGeometry, TYRE_COLOR, { outline: 0.03 });

    const hubGeometry = new THREE.CylinderGeometry(0.2, 0.2, WIDTH + 0.04, 8);
    hubGeometry.rotateZ(Math.PI / 2);
    this.tyre.add(toonMesh(hubGeometry, HUB_COLOR, { outline: 0 }));
    // A spoke bar so you can see the wheel turning.
    this.tyre.add(toonMesh(new THREE.BoxGeometry(WIDTH + 0.08, 0.5, 0.08), HUB_COLOR, { outline: 0 }));

    this.steerGroup.add(this.tyre);
    this.visual.add(this.steerGroup);
  }
}

/** Sideways grip (0..1 of peak) for a slip angle: rises to the peak, then fades toward slidingGrip. */
function lateralGripCurve(slipAngle) {
  const peak = THREE.MathUtils.degToRad(wheelTuning.peakSlipDegrees);
  const slip = Math.abs(slipAngle);
  if (slip <= peak) return slip / peak;
  const fade = Math.min((slip - peak) / (2 * peak), 1);
  return 1 - (1 - wheelTuning.slidingGrip) * fade;
}
