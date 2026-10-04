import * as THREE from 'three';

// Procedural audio: no assets, everything synthesized. Wind, the hub motors, the rotors, boost,
// surge pads. The context starts on the first input gesture (browser autoplay rules); every update
// just moves gains and pitches toward their targets, so the frame rate never matters.
const MASTER_GAIN = 0.4;
const WIND_FULL_SPEED = 55;   // m/s where the wind reaches full voice
// The hub motors: EV inverter whine. One dominant sweeping tone, a slightly detuned twin beating
// against it, one faint non-integer partial. No harmonic ladders and no sub-bass: those are what
// make a sound read as combustion. Nearly silent at a standstill, like a real electric.
const EV_BASE_HZ = 150;
const EV_PITCH_PER_SPIN = 3.0;  // Hz of whine per rad/s of average wheel spin
const EV_MAX_HZ = 950;
const EV_TWIN_DETUNE_HZ = 2.5;  // the beat: movement without any firing order
const EV_OCTAVE_RATIO = 2.02;   // inexact on purpose: exact ratios read as engine harmonics
const EV_OCTAVE_GAIN = 0.12;
const EV_SPIN_FULL = 45;        // rad/s of wheel spin where the whine reaches full voice
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

    // The hub motors: EV inverter whine — fundamental + beating twin + one faint inexact partial.
    this.motorFilter = context.createBiquadFilter();
    this.motorFilter.type = 'lowpass';
    this.motorFilter.frequency.value = 1500;
    this.motorGain = context.createGain();
    this.motorGain.gain.value = 0;
    this.motorOsc = context.createOscillator();      // the dominant whine
    this.motorOsc.type = 'sine';
    this.motorTwin = context.createOscillator();     // detuned twin: the beat that makes it shimmer
    this.motorTwin.type = 'sine';
    this.motorTwinGain = context.createGain();
    this.motorTwinGain.gain.value = 0.55;
    this.motorOctave = context.createOscillator();   // faint 2.02× — mechanical, not combustion
    this.motorOctave.type = 'sine';
    this.motorOctaveGain = context.createGain();
    this.motorOctaveGain.gain.value = EV_OCTAVE_GAIN;
    this.motorOsc.connect(this.motorFilter);
    this.motorTwin.connect(this.motorTwinGain).connect(this.motorFilter);
    this.motorOctave.connect(this.motorOctaveGain).connect(this.motorFilter);
    this.motorFilter.connect(this.motorGain).connect(master);
    this.motorOsc.start();
    this.motorTwin.start();
    this.motorOctave.start();

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
      ? THREE.MathUtils.clamp(vehicle.powerDraw() / vehicle.maxPower(), 0, 1.5) : 0;
    const spinFraction = THREE.MathUtils.clamp(spin / EV_SPIN_FULL, 0, 1);
    const motorHz = Math.min(EV_BASE_HZ + spin * EV_PITCH_PER_SPIN, EV_MAX_HZ);
    ease(this.motorOsc.frequency, motorHz);
    ease(this.motorTwin.frequency, motorHz + EV_TWIN_DETUNE_HZ);
    ease(this.motorOctave.frequency, motorHz * EV_OCTAVE_RATIO);
    ease(this.motorFilter.frequency, 1500 + motorHz);
    ease(this.motorGain.gain, powerFraction * (0.05 + 0.38 * spinFraction));

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