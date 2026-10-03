import * as THREE from 'three';

/**
 * Part: anything bolted to a Chassis at a mount point: wheels and rotors today, engines and cargo racks later.
 * Holds the mount point, the visual, and a log of the pushes it made this step, which Telemetry draws as arrows.
 * Wheel and Rotor extend it; Vehicle keeps them all in one parts list and picks out each kind where it needs to.
 */
export class Part {
  name;
  mountPoint;                  // chassis-local, metres
  visual = new THREE.Group();  // child of the chassis visual, so it moves with the bodywork
  appliedForces = [];          // [{ force, point, kind }] in world space, this step only

  constructor(name, mountPoint) {
    this.name = name;
    this.mountPoint = mountPoint.clone();
    this.visual.position.copy(mountPoint);
  }

  /** Pushes on the chassis at a world point and logs the push for Telemetry. */
  push(chassis, force, point, kind) {
    chassis.push(force, point);
    this.appliedForces.push({ force: force.clone(), point: point.clone(), kind });
  }

  /** Forgets last step's pushes; Vehicle calls this at the start of every step. */
  clearForces() {
    this.appliedForces.length = 0;
  }

  /** The pushes this part made during the latest step. */
  forces() {
    return this.appliedForces;
  }

  /** Brings the visual up to date with the physics state; frameSeconds drives animation like spinning. */
  updateVisual(frameSeconds) {}

  /** Returns the part to its just-bolted-on state. */
  reset() {
    this.clearForces();
  }
}
