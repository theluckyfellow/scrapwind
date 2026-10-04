import * as THREE from 'three';

export const drivetrainTuning = {
  brakeDeceleration: 0.95,     // g of braking at full pedal, shared out by the weight on each wheel
  handbrakeDeceleration: 0.8,  // g on the non-steering wheels
  reverseSpeedLimit: 8,        // m/s
  boostPower: 1.8,             // how many times the motors' torque the boost asks for
  assistPedalSlew: 2.5,        // 1/s; assisted driving ramps the pedal this fast, smoothing binary keys
};

const PARK_SPEED = 0.7;            // m/s; below this with no pedal, the brakes hold the vehicle still
const REVERSE_ENGAGE_SPEED = 1.0;  // m/s; holding the brake below this switches to reverse
const PEDAL_THRESHOLD = 0.1;

/**
 * Drivetrain: the electric drive. Turns the pedals into a torque request for every Wheel's hub motor and a
 * brake force for every wheel. There is no gearbox: hub motors pull from a standstill. The brake pedal becomes
 * reverse once stopped, and the brakes hold the vehicle still when parked.
 * Vehicle runs the motor requests past the BatteryPack before the wheels apply them.
 */
export class Drivetrain {
  reversing = false;
  drivePedal = 0;   // −1..1: positive drives forward, negative in reverse
  brakePedal = 0;   // 0..1 after reverse and parking logic
  boostPedal = 0;   // 0..1: extra motor torque drawn from the surge capacitors
  torqueSplit = 0.5; // share of the torque request sent to the rear axle; the front gets the rest
  brakeBias = 0.55;  // share of the braking asked of the front wheels
  assists = false;   // assisted driving: smooth the pedals instead of taking them raw

  /** Works out this step's direction, drive pedal and braking from the driver's pedals. */
  update(throttle, brake, forwardSpeed, boost = 0, dt = 1 / 60) {
    if (this.reversing) {
      if (throttle > PEDAL_THRESHOLD && forwardSpeed > -REVERSE_ENGAGE_SPEED) this.reversing = false;
    } else if (brake > PEDAL_THRESHOLD && throttle < PEDAL_THRESHOLD && forwardSpeed < REVERSE_ENGAGE_SPEED) {
      this.reversing = true;
    }

    const pedal = this.reversing ? brake : throttle;
    this.brakePedal = this.reversing ? throttle : brake;
    const tooFastBackwards = this.reversing && forwardSpeed < -drivetrainTuning.reverseSpeedLimit;
    const target = tooFastBackwards ? 0 : (this.reversing ? -pedal : pedal);
    if (this.assists) {
      const slew = drivetrainTuning.assistPedalSlew * dt;
      this.drivePedal += THREE.MathUtils.clamp(target - this.drivePedal, -slew, slew);
    } else {
      this.drivePedal = target;
    }
    if (pedal < PEDAL_THRESHOLD && Math.abs(forwardSpeed) < PARK_SPEED) this.brakePedal = 1;
    this.boostPedal = boost;
  }

  /**
   * Torque (N·m) this wheel's motor is asked for, before the batteries and capacitors have their say.
   * The torque split favours an axle by throttling the other down; a motor never exceeds its own limit.
   */
  motorRequest(wheel) {
    const boost = this.boostPedal > 0.5 && this.drivePedal > 0 ? drivetrainTuning.boostPower : 1;
    const share = wheel.steers() ? (1 - this.torqueSplit) * 2 : this.torqueSplit * 2;
    return this.drivePedal * boost * wheel.motorTorqueLimit() * Math.min(share, 1);
  }

  /** Brake force (N) for a wheel, in proportion to the weight it carries, front biased by the brake dial. */
  brakeForce(wheel) {
    const share = wheel.steers() ? this.brakeBias * 2 : (1 - this.brakeBias) * 2;
    return this.brakePedal * drivetrainTuning.brakeDeceleration * wheel.restingLoad * share;
  }

  /** Handbrake force (N): only the wheels that don't steer, so the tail can swing out. */
  handbrakeForce(wheel, held) {
    return held && !wheel.steers() ? drivetrainTuning.handbrakeDeceleration * wheel.restingLoad : 0;
  }

  directionLabel() {
    return this.reversing ? 'R' : 'D';
  }

  reset() {
    this.reversing = false;
    this.drivePedal = 0;
    this.brakePedal = 0;
    this.boostPedal = 0;
  }
}
