export const drivetrainTuning = {
  brakeDeceleration: 0.95,     // g of braking at full pedal, shared out by the weight on each wheel
  handbrakeDeceleration: 0.8,  // g on the non-steering wheels
  reverseSpeedLimit: 8,        // m/s
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

  /** Works out this step's direction, drive pedal and braking from the driver's pedals. */
  update(throttle, brake, forwardSpeed) {
    if (this.reversing) {
      if (throttle > PEDAL_THRESHOLD && forwardSpeed > -REVERSE_ENGAGE_SPEED) this.reversing = false;
    } else if (brake > PEDAL_THRESHOLD && throttle < PEDAL_THRESHOLD && forwardSpeed < REVERSE_ENGAGE_SPEED) {
      this.reversing = true;
    }

    const pedal = this.reversing ? brake : throttle;
    this.brakePedal = this.reversing ? throttle : brake;
    const tooFastBackwards = this.reversing && forwardSpeed < -drivetrainTuning.reverseSpeedLimit;
    this.drivePedal = tooFastBackwards ? 0 : (this.reversing ? -pedal : pedal);
    if (pedal < PEDAL_THRESHOLD && Math.abs(forwardSpeed) < PARK_SPEED) this.brakePedal = 1;
  }

  /** Torque (N·m) this wheel's motor is asked for, before the batteries have their say. */
  motorRequest(wheel) {
    return this.drivePedal * wheel.motorTorqueLimit();
  }

  /** Brake force (N) for a wheel, in proportion to the weight it carries. */
  brakeForce(wheel) {
    return this.brakePedal * drivetrainTuning.brakeDeceleration * wheel.restingLoad;
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
  }
}
