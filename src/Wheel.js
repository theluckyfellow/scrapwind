import * as THREE from 'three';
import { Part } from './Part.js';
import { toonMesh } from './toon.js';
import { wheelHubPosition } from './catalog.js';

export const wheelTuning = {
  dampingRatio: 0.5,          // suspension damping relative to critical; higher settles faster but rides harsher
  stiffnessScale: 1.0,        // multiplies the auto-tuned spring rates
  tyreGrip: 1.0,              // multiplies every tyre's own grip
  peakSlipDegrees: 8,         // slip angle where sideways grip peaks
  slidingGrip: 0.78,          // fraction of peak sideways grip left at big slip angles (drifting)
  kineticGrip: 0.8,           // fraction of grip left once a tyre is asked for more than it has
  tyreForceLift: 0.35,        // 0 = tyre forces act at the ground, 1 = at the centre of mass; higher resists rollovers
};

// How the suspension follows ride height: more clearance buys more travel and softer springs (and a higher
// centre of mass); less clearance gives stiff, precise and short-travel suspension.
const TRAVEL_PER_RIDE_HEIGHT = 0.8;  // compression room above the resting position, per metre of ride height
const MIN_TRAVEL = 0.08;             // m
const BASE_DROOP = 0.08;             // m the spring is compressed at rest...
const DROOP_PER_RIDE_HEIGHT = 0.3;   // ...plus this per metre of ride height
const BUMP_STOP_FRACTION = 0.92;     // of the spring's full length
const BUMP_STOP_MULTIPLE = 12;       // bump stop stiffness, in spring stiffnesses
const GRAVITY = 9.81;
// Slip-angle maths divides by forward speed; this floor keeps a parked tyre from dividing by zero.
const LOW_SPEED_FLOOR = 1.5;      // m/s
// At low speed a tyre cancels sideways creep directly, but only this much per step, so tyres don't overshoot together.
const LATERAL_HOLD = 0.5;
// How far past its grip a tyre must be pushed before it is fully on kinetic (sliding) grip.
const OVERLOAD_BLEND = 0.5;
const WHEELSPIN_SURPLUS = 45;     // rad/s of extra spin at full wheelspin
const SPIN_RESPONSE = 14;         // 1/s, how fast a locked or spinning wheel reaches its target spin
const AIR_SPIN_PER_TORQUE = 0.08; // rad/s² of free spin per N·m of drive while airborne (visual only)
const AIR_SPIN_DECAY = 0.6;       // 1/s
const DROOP_RATE = 3;             // m/s the wheel drops when it leaves the ground
// A stalled motor still draws current; count power as if the tyre were rolling at least this fast.
const MIN_POWER_SPEED = 2;        // m/s

const TYRE_COLOR = 0x2a2522;
const MOTOR_COLOR = 0x3f8f8a;
const STRUT_COLOR = 0x8a9496;
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Wheel: a wheel unit (tyre, ray-cast suspension strut and hub motor in one) mounted on the frame.
 * fitSuspension() sizes its spring to the weight it carries and the ride height; sense() finds the ground
 * (asking the TestTrack) and pushes the Chassis up; grip() turns motor torque, brakes and steering into
 * tyre forces, capped by the friction circle. Vehicle steers it and feeds it torque from the Drivetrain.
 */
export class Wheel extends Part {
  model;
  side;                         // −1 left, +1 right, 0 centre line
  steering = false;
  steerAngle = 0;               // radians, positive steers right
  restingLoad = 0;              // N this wheel carries when the vehicle sits still
  rayTop = new THREE.Vector3(); // chassis-local: the hub's position at full compression
  restLength = 0;               // m from full compression to full droop
  travel = 0;                   // m of compression room above the resting position
  springStiffness = 0;
  damping = 0;
  inContact = false;
  compression = 0;              // m from full droop; can pass restLength when squashed into the bump stop
  previousCompression = 0;
  springLength = 0;             // m from full compression down to where the hub is now
  load = 0;                     // N pressing the tyre into the ground
  ground = null;                // last hit from TestTrack.probeGround
  spinSpeed = 0;                // rad/s, positive rolls forward
  spinAngle = 0;
  slipAngle = 0;
  sliding = false;
  brakingPower = 0;             // W the brakes turned into heat last step, for regeneration
  hubGroup = new THREE.Group();
  steerGroup = new THREE.Group();
  tyre;
  strut;

  constructor(name, model, mountPoint, mountId) {
    super(name, mountPoint, mountId);
    this.model = model;
    this.side = Math.sign(mountPoint.x);
    this.visual.position.set(0, 0, 0); // drawn from the chassis origin: the strut runs from mount to hub
    this.buildVisual();
  }

  steers() { return this.steering; }
  left() { return this.side < 0; }
  hubX() { return this.rayTop.x; }
  hubZ() { return this.rayTop.z; }
  touchingGround() { return this.inContact; }
  spin() { return this.spinSpeed; }
  compressionAmount() { return this.inContact ? this.compression : 0; }

  /** Makes this a steering wheel (or not). */
  setSteering(steering) {
    this.steering = steering;
  }

  /** Sets the steering angle in radians; positive steers right. */
  setSteerAngle(angle) {
    this.steerAngle = this.steering ? angle : 0;
  }

  /** Sizes the spring and damper for the weight this wheel carries at the given ride height. */
  fitSuspension(restingLoad, rideHeight) {
    const mount = this.mountPoint.toArray();
    const hub = wheelHubPosition(this.model, mount, rideHeight);
    const droop = BASE_DROOP + rideHeight * DROOP_PER_RIDE_HEIGHT;
    this.restingLoad = restingLoad;
    this.travel = Math.max(MIN_TRAVEL, rideHeight * TRAVEL_PER_RIDE_HEIGHT);
    this.restLength = this.travel + droop;
    this.rayTop.set(hub[0], hub[1] + this.travel, hub[2]);
    this.springStiffness = (restingLoad / droop) * wheelTuning.stiffnessScale;
    this.damping = 2 * wheelTuning.dampingRatio * Math.sqrt(this.springStiffness * (restingLoad / GRAVITY));
    if (!this.inContact) this.springLength = this.travel;
  }

  /** Sits the wheel at its resting position, for the garage preview. */
  settle() {
    this.springLength = this.travel;
    this.spinSpeed = 0;
  }

  /** Most torque the hub motor can give right now: full torque, then constant power, then nothing at top speed. */
  motorTorqueLimit() {
    const spin = Math.abs(this.spinSpeed);
    if (spin >= this.model.maxSpeed / this.model.radius) return 0;
    return Math.min(this.model.motorTorque, this.model.motorPower / Math.max(spin, 1e-3));
  }

  /** Electrical power (W) the motor would draw to make this torque at the current wheel speed. */
  motorPower(torque) {
    return Math.abs(torque) * Math.max(Math.abs(this.spinSpeed), MIN_POWER_SPEED / this.model.radius);
  }

  /** Casts down from the top of the strut to find the ground, then pushes the chassis up with the spring and damper. */
  sense(chassis, track, dt) {
    const top = chassis.toWorld(this.rayTop);
    const up = chassis.up();
    const down = up.clone().negate();
    const hit = track.probeGround(top, down, this.restLength + this.model.radius, chassis);

    if (!hit) {
      this.leaveGround(dt);
      return;
    }

    const springLength = hit.distance - this.model.radius;
    this.compression = this.restLength - springLength;
    const compressionSpeed = (this.compression - this.previousCompression) / dt;
    this.previousCompression = this.compression;

    let force = this.springStiffness * this.compression + this.damping * compressionSpeed;
    const bumpStop = this.restLength * BUMP_STOP_FRACTION;
    if (this.compression > bumpStop) {
      force += this.springStiffness * BUMP_STOP_MULTIPLE * (this.compression - bumpStop);
    }

    this.inContact = true;
    this.ground = hit;
    this.load = Math.max(force, 0);
    this.springLength = THREE.MathUtils.clamp(springLength, 0, this.restLength);
    const suspensionForce = up.multiplyScalar(this.load);
    this.push(chassis, suspensionForce, top, 'suspension');
    track.pushBack(hit, suspensionForce, dt);
  }

  /** Adds (or removes) load, pushing the chassis to match; the anti-roll bar uses this. */
  shareLoad(chassis, extraLoad) {
    if (!this.inContact) return;
    const newLoad = Math.max(this.load + extraLoad, 0);
    const change = newLoad - this.load;
    this.load = newLoad;
    this.push(chassis, chassis.up().multiplyScalar(change), chassis.toWorld(this.rayTop), 'suspension');
  }

  /**
   * Works out the tyre's push from motor torque, braking and how it is sliding, limited by grip × load.
   * driveTorque in N·m, brakeForce and handbrakeForce in N.
   */
  grip(chassis, track, driveTorque, brakeForce, handbrakeForce, dt) {
    this.brakingPower = 0;
    if (!this.inContact) {
      this.sliding = false;
      this.spinInAir(driveTorque, brakeForce + handbrakeForce, dt);
      return;
    }

    const radius = this.model.radius;
    const surface = this.ground.surface;
    const normal = this.ground.normal;
    const looseness = surface.loose ? this.model.looseGrip : 1;
    const maxForce = wheelTuning.tyreGrip * this.model.grip * looseness * surface.grip * this.load;

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
    const holdForce = (Math.abs(lateralSpeed) * carriedMass / dt) * LATERAL_HOLD;
    let lateral = -Math.sign(lateralSpeed) * Math.min(curveForce, holdForce);

    // Along: drive, plus brakes and rolling resistance, which may stop the wheel but never push it backwards.
    const driveForce = driveTorque / radius;
    const stoppingDemand = brakeForce + handbrakeForce + surface.rollingResistance * this.load;
    const stoppingForce = Math.min(stoppingDemand, (Math.abs(longitudinalSpeed) * carriedMass) / dt);
    let longitudinal = driveForce - Math.sign(longitudinalSpeed) * stoppingForce;
    this.brakingPower = Math.min(brakeForce, stoppingForce) * Math.abs(longitudinalSpeed);

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
    // leverage is untouched) trades a little realism for a vehicle that doesn't trip over its own tyres.
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
    this.hubGroup.position.set(this.rayTop.x, this.rayTop.y - this.springLength, this.rayTop.z);
    this.steerGroup.rotation.y = -this.steerAngle;
    this.tyre.rotation.x = -this.spinAngle;

    // Stretch the strut from its mount on the frame down to the hub.
    const length = this.mountPoint.distanceTo(this.hubGroup.position);
    this.strut.visible = length > 0.02;
    this.strut.position.lerpVectors(this.mountPoint, this.hubGroup.position, 0.5);
    this.strut.quaternion.setFromUnitVectors(UP, this.hubGroup.position.clone().sub(this.mountPoint).normalize());
    this.strut.scale.set(1, length, 1);
  }

  reset() {
    super.reset();
    this.steerAngle = 0;
    this.inContact = false;
    this.compression = 0;
    this.previousCompression = 0;
    this.springLength = this.travel;
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
    this.springLength = Math.min(this.springLength + DROOP_RATE * dt, this.restLength);
  }

  updateSpin(longitudinalSpeed, driveForce, stoppingDemand, overload, dt) {
    const rollingSpin = longitudinalSpeed / this.model.radius;
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
    const { radius, width } = this.model;
    const tyreGeometry = new THREE.CylinderGeometry(radius, radius, width, 16);
    tyreGeometry.rotateZ(Math.PI / 2);
    this.tyre = toonMesh(tyreGeometry, TYRE_COLOR, { outline: 0.03 });

    // The hub motor: a fat drum filling the rim, with a bar across it so you can see it turn.
    const motorGeometry = new THREE.CylinderGeometry(radius * 0.55, radius * 0.55, width + 0.04, 10);
    motorGeometry.rotateZ(Math.PI / 2);
    this.tyre.add(toonMesh(motorGeometry, MOTOR_COLOR, { outline: 0 }));
    this.tyre.add(toonMesh(new THREE.BoxGeometry(width + 0.08, radius * 1.1, 0.07), STRUT_COLOR, { outline: 0 }));

    this.steerGroup.add(this.tyre);
    this.hubGroup.add(this.steerGroup);
    this.visual.add(this.hubGroup);

    this.strut = toonMesh(new THREE.CylinderGeometry(0.045, 0.045, 1, 6), STRUT_COLOR, { outline: 0.012 });
    this.visual.add(this.strut);
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
