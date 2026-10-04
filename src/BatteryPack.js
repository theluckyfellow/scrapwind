export const batteryTuning = {
  drainScale: 1,          // multiplies every watt-hour used; turn down for longer test sessions
};

const DEFAULT_REGEN = 0.35; // fraction of braking energy put back; a design's regen dial overrides this

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
  auxiliaryWatts = 0; // unrequested losses counted on top of what was granted (rotor heat, mostly)
  lastPower = 0;   // watts used in the last finished step
  regenFraction = DEFAULT_REGEN; // share of braking power taken back; set from the design's regen dial

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
    this.auxiliaryWatts = 0;
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
    this.spread(-(watts * this.regenFraction * dt) / SECONDS_PER_HOUR);
  }

  /** Gives charge away (to a relay), in watt-hours; returns how much the batteries actually had to give. */
  discharge(wattHours) {
    const before = this.charge();
    this.spread(Math.min(Math.max(wattHours, 0), before));
    return before - this.charge();
  }

  /** Tops the pack up from outside (a surge pad, a relay's plate), in watt-hours; returns what fitted. */
  topUp(wattHours) {
    const before = this.charge();
    this.spread(-wattHours);
    return this.charge() - before;
  }

  /** Ends the step: drains the batteries for the power used, plus the auxiliary losses. */
  finishStep(dt) {
    const total = this.used + this.auxiliaryWatts;
    this.spread((total * batteryTuning.drainScale * dt) / SECONDS_PER_HOUR);
    this.lastPower = total;
  }

  spread(wattHours) {
    const capacity = this.capacity();
    if (capacity <= 0) return;
    for (const battery of this.batteries) battery.drain((wattHours * battery.capacity()) / capacity);
  }
}
