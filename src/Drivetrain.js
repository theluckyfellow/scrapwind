import * as THREE from 'three';

export const drivetrainTuning = {
  peakTorque: 330,          // N·m at the crank
  idleRpm: 1000,
  peakTorqueRpm: 4200,
  redlineRpm: 7000,
  shiftUpRpm: 6400,
  shiftDownRpm: 3000,
  finalDrive: 6.8,
  reverseRatio: 2.9,
  efficiency: 0.85,
  frontDriveShare: 0.4,     // fraction of drive torque sent to the front axle (all-wheel drive)
  brakeForce: 8000,         // N across all four wheels at full pedal
  frontBrakeShare: 0.6,
  handbrakeForce: 5000,     // N per rear wheel
};

const GEAR_RATIOS = [2.7, 1.9, 1.45, 1.17, 1.0];
const SHIFT_PAUSE_SECONDS = 0.35;   // stops the gearbox hunting up and down
const PARK_SPEED = 0.7;             // m/s; below this with no pedal, the brakes hold the buggy still
const REVERSE_ENGAGE_SPEED = 1.0;   // m/s; holding the brake below this switches to reverse
const PEDAL_THRESHOLD = 0.1;
const RADIANS_PER_SECOND_TO_RPM = 60 / (2 * Math.PI);

/**
 * Drivetrain: the engine and an automatic gearbox.
 * Vehicle tells it the pedals, road speed and how fast the wheels spin; it answers with drive torque
 * and brake force for each Wheel. The brake pedal becomes the reverse throttle once the buggy has stopped.
 */
export class Drivetrain {
  gearIndex = 0;
  reversing = false;
  engineRpm = drivetrainTuning.idleRpm;
  shiftTimer = 0;
  totalWheelTorque = 0;   // N·m across all driven wheels
  brakePedal = 0;         // 0..1 after reverse and parking logic

  /** Works out this step's gear, engine speed, drive torque and braking. */
  update(throttle, brake, forwardSpeed, wheelSpinSpeed, dt) {
    const tuning = drivetrainTuning;
    if (this.reversing) {
      if (throttle > PEDAL_THRESHOLD && forwardSpeed > -REVERSE_ENGAGE_SPEED) this.reversing = false;
    } else if (brake > PEDAL_THRESHOLD && throttle < PEDAL_THRESHOLD && forwardSpeed < REVERSE_ENGAGE_SPEED) {
      this.reversing = true;
    }

    const pedal = this.reversing ? brake : throttle;
    this.brakePedal = this.reversing ? throttle : brake;
    if (this.reversing) this.gearIndex = 0;

    const ratio = this.reversing ? -tuning.reverseRatio : GEAR_RATIOS[this.gearIndex];
    const engineSpin = Math.abs(wheelSpinSpeed * ratio * tuning.finalDrive);
    this.engineRpm = Math.max(tuning.idleRpm, engineSpin * RADIANS_PER_SECOND_TO_RPM);
    this.shiftGears(dt);

    const limiter = this.engineRpm < tuning.redlineRpm ? 1 : 0;
    const engineTorque = pedal * this.torqueAt(this.engineRpm) * limiter;
    this.totalWheelTorque = engineTorque * ratio * tuning.finalDrive * tuning.efficiency;

    if (pedal < PEDAL_THRESHOLD && Math.abs(forwardSpeed) < PARK_SPEED) this.brakePedal = 1;
  }

  /** Drive torque for one wheel on the given axle, N·m. */
  wheelTorque(isFront) {
    const share = isFront ? drivetrainTuning.frontDriveShare : 1 - drivetrainTuning.frontDriveShare;
    return this.totalWheelTorque * share / 2;
  }

  /** Brake force for one wheel on the given axle, N. */
  brakeForce(isFront) {
    const share = isFront ? drivetrainTuning.frontBrakeShare : 1 - drivetrainTuning.frontBrakeShare;
    return this.brakePedal * drivetrainTuning.brakeForce * share / 2;
  }

  rpm() { return this.engineRpm; }
  rpmFraction() { return this.engineRpm / drivetrainTuning.redlineRpm; }
  gearLabel() { return this.reversing ? 'R' : String(this.gearIndex + 1); }

  reset() {
    this.gearIndex = 0;
    this.reversing = false;
    this.engineRpm = drivetrainTuning.idleRpm;
    this.shiftTimer = 0;
    this.totalWheelTorque = 0;
    this.brakePedal = 0;
  }

  shiftGears(dt) {
    this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    if (this.reversing || this.shiftTimer > 0) return;
    if (this.engineRpm > drivetrainTuning.shiftUpRpm && this.gearIndex < GEAR_RATIOS.length - 1) {
      this.gearIndex++;
      this.shiftTimer = SHIFT_PAUSE_SECONDS;
    } else if (this.engineRpm < drivetrainTuning.shiftDownRpm && this.gearIndex > 0) {
      this.gearIndex--;
      this.shiftTimer = SHIFT_PAUSE_SECONDS;
    }
  }

  /** Engine torque curve: builds from idle to the peak, then tails off toward the redline. */
  torqueAt(rpm) {
    const { peakTorque, idleRpm, peakTorqueRpm, redlineRpm } = drivetrainTuning;
    if (rpm <= peakTorqueRpm) {
      return peakTorque * THREE.MathUtils.lerp(0.65, 1, (rpm - idleRpm) / (peakTorqueRpm - idleRpm));
    }
    return peakTorque * THREE.MathUtils.lerp(1, 0.7, (rpm - peakTorqueRpm) / (redlineRpm - peakTorqueRpm));
  }
}
