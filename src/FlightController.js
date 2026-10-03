import * as THREE from 'three';
import { rotorTuning } from './Rotor.js';

export const flightTuning = {
  maxTiltDegrees: 24,
  levelStiffness: 10,     // rad/s² of correction per radian of tilt error
  levelDamping: 5,        // rad/s² per rad/s of unwanted rotation
  maxYawRate: 1.8,        // rad/s at full bumper
  yawResponse: 3,         // 1/s
  maxClimbRate: 8,        // m/s
  climbResponse: 2.2,     // 1/s, how hard it chases the target climb rate
  heightHold: 1.2,        // 1/s, how hard it returns to the held height when the triggers are released
  landingSpeed: 2,        // m/s, the fastest it will descend right at the ground
  landingCushion: 0.8,    // 1/s; each metre of height allows this much more descent speed
  groundIdle: 0.06,       // fraction of max thrust while parked on the ground
};

const GRAVITY = 9.81;
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const INPUT_THRESHOLD = 0.05;
const MIN_UPRIGHTNESS = 0.4; // stops collective thrust exploding when the buggy is near sideways
// Turning only gets this fraction of each rotor's thrust to play with, so a hard turn can never starve
// levelling or lift (the usual drone-mixer priority: stay upright, stay up, then turn).
const YAW_AUTHORITY = 0.35;
// Never dive harder than this (m/s²), so the rotors always keep enough thrust to level and turn.
const MAX_DIVE_ACCELERATION = 0.5 * GRAVITY;
const RIDE_HEIGHT = 0.9; // m from the centre of mass down to the ground when parked

/**
 * FlightController: the buggy's drone brain. Turns the pilot's tilt, climb and turn requests into four
 * rotor thrusts, self-levelling and holding height when the sticks are let go.
 * Vehicle calls fly() each step while the rotors are out; it reads the Chassis and commands each Rotor.
 * Thrust is split by each rotor's lever arm, so the same maths keeps working when the builder moves rotors.
 */
export class FlightController {
  engaged = false;
  holdAltitude = 0;  // m, the height to hold while the climb triggers are released

  /** Commands every rotor for this step. Inputs come from Controls; the track gives height above ground for landings. */
  fly(chassis, rotors, controls, grounded, track) {
    const altitude = chassis.worldCenterOfMass().y;
    const climbInput = controls.value('climb') - controls.value('descend');
    if (!this.engaged) {
      this.engaged = true;
      this.holdAltitude = altitude;
    }

    if (grounded && climbInput <= INPUT_THRESHOLD) {
      for (const rotor of rotors) rotor.command(flightTuning.groundIdle * rotorTuning.maxThrust);
      this.holdAltitude = altitude;
      return;
    }

    const localTorque = this.attitudeTorque(chassis, controls);
    const collective = this.collectiveThrust(chassis, climbInput, altitude, track);
    this.mix(chassis, rotors, collective, localTorque);
  }

  /** Called when the rotors are stowed, so the next take-off holds the height it starts at. */
  disengage() {
    this.engaged = false;
  }

  reset() {
    this.engaged = false;
    this.holdAltitude = 0;
  }

  /** The chassis-local torque that levels the buggy to the requested tilt and turn rate. */
  attitudeTorque(chassis, controls) {
    const up = chassis.up();
    const headingForward = chassis.forward().setY(0);
    if (headingForward.lengthSq() < 1e-4) headingForward.set(0, 0, -1);
    headingForward.normalize();
    const headingRight = new THREE.Vector3().crossVectors(headingForward, WORLD_UP);

    // Tilting forward leans the thrust toward the nose, which pulls the buggy forward.
    const maxTilt = THREE.MathUtils.degToRad(flightTuning.maxTiltDegrees);
    const desiredUp = WORLD_UP.clone()
      .addScaledVector(headingForward, Math.tan(controls.value('tiltForward') * maxTilt))
      .addScaledVector(headingRight, Math.tan(controls.value('tiltRight') * maxTilt))
      .normalize();
    const tiltError = new THREE.Vector3().crossVectors(up, desiredUp);

    const angularVelocity = chassis.angularVelocity();
    const yawRate = angularVelocity.dot(up);
    const tumble = angularVelocity.addScaledVector(up, -yawRate);
    // Positive yaw input turns right, which is clockwise seen from above: negative about up.
    const targetYawRate = -controls.value('yaw') * flightTuning.maxYawRate;

    const angularAcceleration = tiltError.multiplyScalar(flightTuning.levelStiffness)
      .addScaledVector(tumble, -flightTuning.levelDamping)
      .addScaledVector(up, (targetYawRate - yawRate) * flightTuning.yawResponse);

    const inertia = chassis.principalInertia();
    return angularAcceleration.applyQuaternion(chassis.inverseRotation()).multiply(inertia);
  }

  /** Total thrust along the chassis up axis that chases the requested climb rate or holds height. */
  collectiveThrust(chassis, climbInput, altitude, track) {
    const climbRate = chassis.linearVelocity().y;
    let targetClimbRate;
    if (Math.abs(climbInput) > INPUT_THRESHOLD) {
      targetClimbRate = climbInput * flightTuning.maxClimbRate;
      // Where the buggy would coast to a stop if the trigger were released now; holding there avoids a bounce.
      this.holdAltitude = altitude + climbRate / flightTuning.climbResponse;
    } else {
      targetClimbRate = THREE.MathUtils.clamp(
        (this.holdAltitude - altitude) * flightTuning.heightHold,
        -flightTuning.maxClimbRate,
        flightTuning.maxClimbRate,
      );
    }
    if (targetClimbRate < 0) {
      // Landing cushion: the nearer the ground, the gentler the descent, so holding descend sets it down softly.
      const centerOfMass = chassis.worldCenterOfMass();
      const height = Math.max(altitude - track.heightAt(centerOfMass.x, centerOfMass.z) - RIDE_HEIGHT, 0);
      targetClimbRate = Math.max(targetClimbRate, -(flightTuning.landingSpeed + flightTuning.landingCushion * height));
    }
    const verticalAcceleration = Math.max((targetClimbRate - climbRate) * flightTuning.climbResponse, -MAX_DIVE_ACCELERATION);
    const uprightness = Math.max(chassis.up().y, MIN_UPRIGHTNESS);
    return chassis.mass() * (GRAVITY + verticalAcceleration) / uprightness;
  }

  /**
   * Splits collective thrust and a chassis-local torque across the rotors by their lever arms.
   * Pitch comes from front-versus-back thrust, roll from left-versus-right, and turning from the
   * difference between clockwise and anticlockwise rotors' blade drag.
   */
  mix(chassis, rotors, collective, localTorque) {
    const centerOfMass = chassis.localCenterOfMass();
    const arms = rotors.map(rotor => rotor.leverArm(centerOfMass));
    const sumZSquared = arms.reduce((sum, arm) => sum + arm.z * arm.z, 0);
    const sumXSquared = arms.reduce((sum, arm) => sum + arm.x * arm.x, 0);

    const pitchShare = localTorque.x / sumZSquared;
    const rollShare = localTorque.z / sumXSquared;
    const baseThrust = collective / rotors.length;
    const hoverThrust = chassis.mass() * GRAVITY / rotors.length;
    const yawLimit = Math.min(hoverThrust * YAW_AUTHORITY, baseThrust);
    const yawShare = THREE.MathUtils.clamp(localTorque.y / (rotorTuning.yawTorquePerThrust * rotors.length), -yawLimit, yawLimit);

    rotors.forEach((rotor, index) => {
      const arm = arms[index];
      rotor.command(baseThrust - pitchShare * arm.z + rollShare * arm.x - yawShare * rotor.spinSign());
    });
  }
}
