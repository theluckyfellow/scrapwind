import * as THREE from 'three';

export const cameraTuning = {
  distance: 7.2,          // m behind the buggy
  height: 2.4,            // m above it
  lookHeight: 1.1,        // m above the buggy's origin the camera aims at
  followSharpness: 7,     // 1/s; higher sticks tighter to the buggy
  headingSharpness: 4,    // 1/s; how quickly the camera swings round behind
  baseFov: 64,            // degrees
  speedFov: 16,           // extra degrees at fovTopSpeed, for a sense of speed
  fovTopSpeed: 45,        // m/s
  boostFov: 7,            // extra degrees while boosting
  boostPullback: 0.9,     // m the camera falls back while boosting
  boostResponse: 6,       // 1/s, how quickly the boost kick comes and goes
  orbitSpeed: 2.6,        // rad/s from the right stick
  orbitReturn: 2.5,        // 1/s back to centre once the stick is released
};

const MIN_GROUND_CLEARANCE = 1.0;
const MIN_ORBIT_PITCH = -0.3;
const MAX_ORBIT_PITCH = 0.9;
const LOOK_THRESHOLD = 0.1;
const LOCAL_FORWARD = new THREE.Vector3(0, 0, -1);

/**
 * ChaseCamera: a smoothed follow camera that swings round behind the buggy, widens its view with speed,
 * orbits with the right stick and keeps itself above the ground by asking the TestTrack how high it is.
 * Game updates it once per frame with the vehicle's drawn pose.
 */
export class ChaseCamera {
  camera;
  track;
  heading = 0;           // radians; 0 looks north (−Z)
  orbitYaw = 0;
  orbitPitch = 0;
  position = new THREE.Vector3();
  placed = false;
  boostBlend = 0;        // 0..1, eased in and out while boost is held

  constructor(camera, track) {
    this.camera = camera;
    this.track = track;
  }

  /** Moves the camera toward its spot behind the target. lookRight and lookUp are -1..1 stick values; boosting is 0 or 1. */
  update(targetPosition, targetQuaternion, speed, lookRight, lookUp, dt, boosting = 0) {
    this.followHeading(targetQuaternion, dt);
    this.orbit(lookRight, lookUp, dt);
    this.boostBlend += (boosting - this.boostBlend) * (1 - Math.exp(-cameraTuning.boostResponse * dt));

    const yaw = this.heading + this.orbitYaw;
    const distance = cameraTuning.distance + cameraTuning.boostPullback * this.boostBlend;
    const horizontal = distance * Math.cos(this.orbitPitch);
    const desired = new THREE.Vector3(Math.sin(yaw) * horizontal, cameraTuning.height + cameraTuning.distance * Math.sin(this.orbitPitch), Math.cos(yaw) * horizontal)
      .add(targetPosition);
    desired.y = Math.max(desired.y, this.track.heightAt(desired.x, desired.z) + MIN_GROUND_CLEARANCE);

    if (this.placed) {
      this.position.lerp(desired, 1 - Math.exp(-cameraTuning.followSharpness * dt));
    } else {
      this.position.copy(desired);
      this.placed = true;
    }
    this.camera.position.copy(this.position);
    this.camera.lookAt(targetPosition.x, targetPosition.y + cameraTuning.lookHeight, targetPosition.z);

    const fov = cameraTuning.baseFov
      + cameraTuning.speedFov * THREE.MathUtils.clamp(speed / cameraTuning.fovTopSpeed, 0, 1)
      + cameraTuning.boostFov * this.boostBlend;
    if (Math.abs(fov - this.camera.fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Snaps straight to the new spot on the next update, e.g. after a respawn. */
  reset() {
    this.placed = false;
    this.orbitYaw = 0;
    this.orbitPitch = 0;
    this.boostBlend = 0;
  }

  followHeading(targetQuaternion, dt) {
    const forward = LOCAL_FORWARD.clone().applyQuaternion(targetQuaternion);
    // Pointing nearly straight up or down there is no useful heading; keep the last one.
    if (forward.x * forward.x + forward.z * forward.z < 0.09) return;
    const targetHeading = Math.atan2(-forward.x, -forward.z);
    const turn = Math.atan2(Math.sin(targetHeading - this.heading), Math.cos(targetHeading - this.heading));
    this.heading += this.placed ? turn * (1 - Math.exp(-cameraTuning.headingSharpness * dt)) : turn;
  }

  orbit(lookRight, lookUp, dt) {
    if (Math.abs(lookRight) > LOOK_THRESHOLD) {
      this.orbitYaw = THREE.MathUtils.clamp(this.orbitYaw - lookRight * cameraTuning.orbitSpeed * dt, -Math.PI, Math.PI);
    } else {
      this.orbitYaw *= Math.exp(-cameraTuning.orbitReturn * dt);
    }
    if (Math.abs(lookUp) > LOOK_THRESHOLD) {
      this.orbitPitch = THREE.MathUtils.clamp(this.orbitPitch + lookUp * cameraTuning.orbitSpeed * dt, MIN_ORBIT_PITCH, MAX_ORBIT_PITCH);
    } else {
      this.orbitPitch *= Math.exp(-cameraTuning.orbitReturn * dt);
    }
  }
}
