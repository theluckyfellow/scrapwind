import * as THREE from 'three';

// Procedural audio: no assets, everything synthesized. Wind, the hub motors, the rotors, boost,
// surge pads. The context starts on the first input gesture (browser autoplay rules); every update
// just moves gains and pitches toward their targets, so the frame rate never matters.
const MASTER_GAIN = 0.4;
const WIND_FULL_SPEED = 55;   // m/s where the wind reaches full voice
// The hub motors: a warm low hum that climbs with wheel speed, a soft glassy partial above it, and a
// faint inverter whine that only sings under load. Kept low and soft-edged: a bright pure tone that
// throbs is the most tiring sound to hear for an hour, and that is what the first version was. The
// partials sit at inexact ratios, so it never reads as an engine's harmonic ladder.
const MOTOR_BASE_HZ = 62;
const MOTOR_PITCH_PER_SPIN = 1.5;  // Hz of hum per rad/s of average wheel spin
const MOTOR_MAX_HZ = 260;
const MOTOR_BODY_BRIGHTNESS = 4;   // the hum's lowpass sits this many times above its pitch
const MOTOR_GLASS_RATIO = 3.01;    // the soft upper partial
const MOTOR_GLASS_GAIN = 0.16;
const MOTOR_CHORUS_HZ = 0.35;      // the glass partial's twin drifts this far off: a slow shimmer, not a throb
const MOTOR_WHINE_RATIO = 7.2;     // the inverter, high above the hum
const MOTOR_WHINE_GAIN = 0.05;     // at full power; silent when coasting
const MOTOR_ROLL_GAIN = 0.035;     // rolling along with no load
const MOTOR_LOAD_GAIN = 0.16;      // added at full power
const MOTOR_ROLL_SPIN = 6;         // rad/s of wheel spin where the rolling hum is fully there
const ROTOR_BASE_HZ = 110;
const ROTOR_PITCH_PER_THRUST = 340; // Hz above base at full thrust
const CHIME_HZ = [880, 1318];
const RELAY_HUM_HZ = 55;        // the grid's hum, an octave under the motors' floor
const WAKE_CHORD_HZ = [220, 277.18, 329.63, 440, 554.37]; // A major, spread wide: a relay waking
const SPIRE_CHORD_HZ = [55, 110, 164.81, 220, 277.18, 329.63, 440, 659.25];

export class Sound {
  context = null;

  constructor() {
    window.addEventListener('pointerdown', () => this.ensure());
    window.addEventListener('keydown', () => this.ensure());
    // A hidden tab shouldn't keep humming.
    document.addEventListener('visibilitychange', () => {
      if (!this.context) return;
      if (document.hidden) this.context.suspend();
      else this.context.resume();
    });
  }

  /** Fades every running voice out: the vehicle has left the track. */
  silence() {
    if (!this.context) return;
    const now = this.context.currentTime;
    for (const gain of [this.windGain, this.motorGain, this.rotorGain, this.boostGain, this.humGain]) gain.gain.setTargetAtTime(0, now, 0.15);
  }

  /** Creates (or resumes) the audio graph; called on the first input gesture. */
  ensure() {
    if (this.context) {
      if (this.context.state === 'suspended') this.context.resume();
      return;
    }
    const context = new AudioContext();
    this.context = context;
    const master = context.createGain();
    master.gain.value = MASTER_GAIN;
    master.connect(context.destination);
    this.master = master;

    // Wind: looped white noise through a bandpass that opens up with speed.
    const noise = context.createBufferSource();
    noise.buffer = this.noiseBuffer(context);
    noise.loop = true;
    this.windFilter = context.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 300;
    this.windFilter.Q.value = 0.7;
    this.windGain = context.createGain();
    this.windGain.gain.value = 0;
    noise.connect(this.windFilter).connect(this.windGain).connect(master);
    noise.start();

    // The hub motors: a filtered triangle hum, a chorused glass partial, and a load-only inverter whine.
    this.motorGain = context.createGain();
    this.motorGain.gain.value = 0;
    this.motorGain.connect(master);
    this.motorFilter = context.createBiquadFilter();
    this.motorFilter.type = 'lowpass';
    this.motorFilter.Q.value = 0.5;
    this.motorFilter.connect(this.motorGain);
    this.motorBody = context.createOscillator();
    this.motorBody.type = 'triangle';
    this.motorBody.connect(this.motorFilter);
    const glassGain = context.createGain();
    glassGain.gain.value = MOTOR_GLASS_GAIN / 2;
    glassGain.connect(this.motorGain);
    this.motorGlass = context.createOscillator();
    this.motorGlassTwin = context.createOscillator();
    for (const glass of [this.motorGlass, this.motorGlassTwin]) glass.connect(glassGain);
    this.motorWhineGain = context.createGain();
    this.motorWhineGain.gain.value = 0;
    this.motorWhineGain.connect(this.motorGain);
    this.motorWhine = context.createOscillator();
    this.motorWhine.connect(this.motorWhineGain);
    for (const voice of [this.motorBody, this.motorGlass, this.motorGlassTwin, this.motorWhine]) voice.start();

    // The rotors: a thin triangle tone, pitch and level riding the thrust.
    this.rotorGain = context.createGain();
    this.rotorGain.gain.value = 0;
    this.rotorOsc = context.createOscillator();
    this.rotorOsc.type = 'triangle';
    this.rotorOsc.connect(this.rotorGain).connect(master);
    this.rotorOsc.start();

    // Boost: the noise again, high-passed to a hiss/crackle.
    const boostNoise = context.createBufferSource();
    boostNoise.buffer = this.noiseBuffer(context);
    boostNoise.loop = true;
    const boostFilter = context.createBiquadFilter();
    boostFilter.type = 'highpass';
    boostFilter.frequency.value = 2800;
    this.boostGain = context.createGain();
    this.boostGain.gain.value = 0;
    boostNoise.connect(boostFilter).connect(this.boostGain).connect(master);
    boostNoise.start();

    // The grid: a low hum that swells and climbs while a relay drinks, through a resonant filter.
    this.humGain = context.createGain();
    this.humGain.gain.value = 0;
    this.humFilter = context.createBiquadFilter();
    this.humFilter.type = 'lowpass';
    this.humFilter.frequency.value = 300;
    this.humFilter.Q.value = 6;
    this.humOsc = context.createOscillator();
    this.humOsc.type = 'sawtooth';
    this.humOsc.frequency.value = RELAY_HUM_HZ;
    this.humOsc.connect(this.humFilter).connect(this.humGain).connect(master);
    this.humOsc.start();
  }

  /** The relay hum: progress 0..1 raises its pitch and opens it up; null silences it. */
  relayHum(progress) {
    if (!this.context) return;
    const now = this.context.currentTime;
    const on = progress !== null;
    this.humGain.gain.setTargetAtTime(on ? 0.05 + progress * 0.1 : 0, now, 0.12);
    this.humOsc.frequency.setTargetAtTime(RELAY_HUM_HZ * (1 + (on ? progress : 0)), now, 0.2);
    this.humFilter.frequency.setTargetAtTime(on ? 300 + progress * 2200 : 300, now, 0.2);
  }

  /** A relay wakes: a wide bright chord that blooms and rings out. The Spire gets a deeper, longer one. */
  wake(spire = false) {
    if (!this.context) return;
    const context = this.context;
    const notes = spire ? SPIRE_CHORD_HZ : WAKE_CHORD_HZ;
    const length = spire ? 9 : 3.5;
    notes.forEach((frequency, index) => {
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = index % 2 ? 'triangle' : 'sine';
      osc.frequency.value = frequency;
      const start = context.currentTime + index * (spire ? 0.18 : 0.06);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(spire ? 0.12 : 0.16, start + 0.08);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
      osc.connect(gain).connect(this.master);
      osc.start(start);
      osc.stop(start + length + 0.1);
    });
  }

  /** Moves every voice toward the vehicle's current state; Game calls this once per frame. */
  update(vehicle, frameSeconds) {
    if (!this.context) return;
    const ease = (param, value) => param.setTargetAtTime(value, this.context.currentTime, Math.min(frameSeconds, 0.1) * 2);
    const speed = vehicle.speed();

    const windLevel = Math.pow(THREE.MathUtils.clamp(speed / WIND_FULL_SPEED, 0, 1), 1.6) * 0.7;
    ease(this.windGain.gain, windLevel);
    ease(this.windFilter.frequency, 300 + speed * 34);

    const wheels = vehicle.wheels();
    const spin = wheels.length
      ? wheels.reduce((sum, wheel) => sum + Math.abs(wheel.spin()), 0) / wheels.length
      : 0;
    const powerFraction = vehicle.maxPower() > 0
      ? THREE.MathUtils.clamp(vehicle.powerDraw() / vehicle.maxPower(), 0, 1) : 0;
    const rolling = THREE.MathUtils.clamp(spin / MOTOR_ROLL_SPIN, 0, 1);
    const motorHz = Math.min(MOTOR_BASE_HZ + spin * MOTOR_PITCH_PER_SPIN, MOTOR_MAX_HZ);
    ease(this.motorBody.frequency, motorHz);
    ease(this.motorFilter.frequency, motorHz * MOTOR_BODY_BRIGHTNESS);
    ease(this.motorGlass.frequency, motorHz * MOTOR_GLASS_RATIO);
    ease(this.motorGlassTwin.frequency, motorHz * MOTOR_GLASS_RATIO + MOTOR_CHORUS_HZ);
    ease(this.motorWhine.frequency, motorHz * MOTOR_WHINE_RATIO);
    ease(this.motorWhineGain.gain, MOTOR_WHINE_GAIN * powerFraction);
    ease(this.motorGain.gain, MOTOR_ROLL_GAIN * rolling + MOTOR_LOAD_GAIN * powerFraction);

    const rotors = vehicle.rotors();
    const thrust = rotors.length
      ? rotors.reduce((sum, rotor) => sum + rotor.thrust / rotor.maxThrust(), 0) / rotors.length : 0;
    ease(this.rotorOsc.frequency, ROTOR_BASE_HZ + thrust * ROTOR_PITCH_PER_THRUST);
    ease(this.rotorGain.gain, rotors.length ? 0.03 + thrust * 0.13 : 0);

    ease(this.boostGain.gain, vehicle.boosting() ? 0.22 : 0);
  }

  /** A two-note chime when a surge pad takes hold. */
  pad() {
    if (!this.context) return;
    const context = this.context;
    CHIME_HZ.forEach((frequency, index) => {
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = 'sine';
      osc.frequency.value = frequency;
      const start = context.currentTime + index * 0.09;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.22, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.5);
      osc.connect(gain).connect(this.master);
      osc.start(start);
      osc.stop(start + 0.55);
    });
  }

  noiseBuffer(context) {
    const buffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < data.length; index++) data[index] = Math.random() * 2 - 1;
    return buffer;
  }
}