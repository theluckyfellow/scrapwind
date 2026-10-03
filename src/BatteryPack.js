export const batteryTuning = {
  drainScale: 1,          // multiplies every watt-hour used; turn down for longer test sessions
  regenEfficiency: 0.3,   // fraction of braking energy put back into the batteries
};

const SECONDS_PER_HOUR = 3600;

/**
 * BatteryPack: all of a vehicle's Batteries working as one. Each physics step the rotors, then the hub
 * motors, ask it for power; it grants what the batteries can deliver (sharing out any shortfall), drains
 * the batteries in proportion to their size and takes back what braking recovers.
 * Vehicle owns one; Telemetry reads its charge and power draw through Vehicle.
 */
export class BatteryPack {
  batteries;
  budget = 0;      // watts available this step
  used = 0;        // watts granted so far this step
  lastPower = 0;   // watts used in the last finished step

  constructor(batteries) {
    this.batteries = batteries;
  }

  capacity() { return this.batteries.reduce((sum, battery) => sum + battery.capacity(), 0); }
  charge() { return this.batteries.reduce((sum, battery) => sum + battery.chargeLeft(), 0); }
  maxPower() { return this.batteries.reduce((sum, battery) => sum + battery.maxPower(), 0); }
  chargeFraction() { return this.capacity() > 0 ? this.charge() / this.capacity() : 0; }
  powerDraw() { return this.lastPower; }

  /** Starts a physics step: an empty pack can give nothing. */
  beginStep() {
    this.budget = this.charge() > 0 ? this.maxPower() : 0;
    this.used = 0;
  }

  /** Asks for some watts; returns the fraction granted (1 = all of it). */
  request(watts) {
    if (watts <= 0) return 1;
    const granted = Math.min(watts, Math.max(this.budget - this.used, 0));
    this.used += granted;
    return granted / watts;
  }

  /** Puts back some of the watts that braking is turning into heat. */
  recover(watts, dt) {
    this.spread(-(watts * batteryTuning.regenEfficiency * dt) / SECONDS_PER_HOUR);
  }

  /** Ends the step: drains the batteries for the power used. */
  finishStep(dt) {
    this.spread((this.used * batteryTuning.drainScale * dt) / SECONDS_PER_HOUR);
    this.lastPower = this.used;
  }

  spread(wattHours) {
    const capacity = this.capacity();
    if (capacity <= 0) return;
    for (const battery of this.batteries) battery.drain((wattHours * battery.capacity()) / capacity);
  }
}
