import { GamepadLayout, gamepadName } from './GamepadLayout.js';
import { readStored, writeStored } from './storage.js';

// What every control does, for a gamepad (read through its GamepadLayout) and the keyboard.
// Analog controls take whichever of the two is pushed further. Driving and flying share some
// controls (the right trigger is both throttle and climb); Vehicle uses the ones its mode needs.
const STICK_DEADZONE = 0.15;      // radial: the stick's distance from centre, not each axis alone
const TRIGGER_DEADZONE = 0.05;
const ACTIVITY_THRESHOLD = 0.35;  // how far a control must move for a pad to count as the one in use
const LAYOUTS_KEY = 'scrapwind-controller-layouts';

const ANALOG_CONTROLS = [
  { name: 'steer', pad: pad => pad.leftX, positiveKeys: ['KeyD', 'ArrowRight'], negativeKeys: ['KeyA', 'ArrowLeft'] },
  { name: 'throttle', pad: pad => pad.rightTrigger, positiveKeys: ['KeyW', 'ArrowUp'] },
  { name: 'brake', pad: pad => pad.leftTrigger, positiveKeys: ['KeyS', 'ArrowDown'] },
  { name: 'handbrake', pad: pad => pad.a, positiveKeys: ['Space'] },
  { name: 'tiltForward', pad: pad => -pad.leftY, positiveKeys: ['KeyW', 'ArrowUp'], negativeKeys: ['KeyS', 'ArrowDown'] },
  { name: 'tiltRight', pad: pad => pad.leftX, positiveKeys: ['KeyD', 'ArrowRight'], negativeKeys: ['KeyA', 'ArrowLeft'] },
  { name: 'climb', pad: pad => pad.rightTrigger, positiveKeys: ['Space'] },
  { name: 'descend', pad: pad => pad.leftTrigger, positiveKeys: ['ShiftLeft', 'ShiftRight'] },
  { name: 'yaw', pad: pad => pad.rightBumper - pad.leftBumper, positiveKeys: ['KeyE'], negativeKeys: ['KeyQ'] },
  { name: 'rideHeight', pad: pad => pad.dpadUp - pad.dpadDown, positiveKeys: ['KeyX'], negativeKeys: ['KeyZ'] },
  { name: 'boost', pad: pad => Math.max(pad.x, pad.leftStickClick), positiveKeys: ['KeyB'] },
  { name: 'lookRight', pad: pad => pad.rightX, positiveKeys: ['KeyL'], negativeKeys: ['KeyJ'] },
  { name: 'lookUp', pad: pad => -pad.rightY, positiveKeys: ['KeyI'], negativeKeys: ['KeyK'] },
];

const BUTTON_CONTROLS = [
  { name: 'toggleRotors', pad: 'y', keys: ['KeyF'] },
  { name: 'flipUpright', pad: 'b', keys: ['KeyR'] },
  { name: 'respawn', pad: 'back', keys: ['Backspace'] },
  { name: 'toggleGarage', pad: 'start', keys: ['Escape'] },
  { name: 'toggleTuning', pad: null, keys: ['KeyG'] },
  { name: 'toggleTelemetry', pad: 'rightStickClick', keys: ['KeyT'] },
];

// Keys the browser would otherwise use to scroll or navigate.
const CAPTURED_KEYS = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace']);

/**
 * Controls: one record of what the player is asking for this frame, from the keyboard and whichever gamepad
 * they touched last. Each pad is read through its GamepadLayout: built in, or one the player made in
 * ControllerSetup (saved per controller). Game polls it once per frame; Vehicle and ChaseCamera read values by
 * name, Game checks one-shot buttons with pressed(), and ControllerSetup reads the raw pad for its wizard.
 */
export class Controls {
  keysDown = new Set();
  keysTappedSincePoll = new Set(); // a tap can go down and up between two polls; this keeps it from being lost
  values = new Map();         // analog control name → -1..1 or 0..1
  buttonsDown = new Map();    // button control name → held this frame
  buttonsPressed = new Set(); // button control names that went down this frame
  layouts = new Map();        // pad id → GamepadLayout in use for it
  customLayouts;              // pad id → bindings the player saved
  activeIndex = null;         // navigator.getGamepads() index of the pad in use
  pad = null;                 // that pad's raw state this frame
  padState = null;            // and its named controls, after deadzones
  onPadChange = null;         // called with a sentence when a controller connects, disconnects or takes over

  constructor(target) {
    this.customLayouts = readStored(LAYOUTS_KEY, {});
    target.addEventListener('keydown', event => this.handleKey(event, true));
    target.addEventListener('keyup', event => this.handleKey(event, false));
    target.addEventListener('blur', () => this.keysDown.clear());
    window.addEventListener('gamepadconnected', event => {
      this.onPadChange?.(`${gamepadName(event.gamepad.id)} connected (${this.layoutFor(event.gamepad).name} layout).`);
    });
    window.addEventListener('gamepaddisconnected', event => {
      if (event.gamepad.index === this.activeIndex) this.activeIndex = null;
      this.onPadChange?.(`${gamepadName(event.gamepad.id)} disconnected.`);
    });
  }

  /** Reads the gamepad and keyboard; call once per frame before anything asks for values. */
  poll() {
    this.pad = this.choosePad();
    this.padState = this.pad ? applyDeadzones(this.layoutFor(this.pad).read(this.pad)) : null;

    for (const control of ANALOG_CONTROLS) {
      const keyboard = this.anyKeyDown(control.positiveKeys) - this.anyKeyDown(control.negativeKeys);
      const gamepad = this.padState ? control.pad(this.padState) : 0;
      this.values.set(control.name, Math.abs(keyboard) > Math.abs(gamepad) ? keyboard : gamepad);
    }

    this.buttonsPressed.clear();
    for (const control of BUTTON_CONTROLS) {
      const padDown = Boolean(this.padState && control.pad && this.padState[control.pad] > 0.5);
      const down = this.anyKeyDown(control.keys) === 1 || padDown;
      const tapped = control.keys.some(key => this.keysTappedSincePoll.has(key));
      if ((down && !this.buttonsDown.get(control.name)) || tapped) this.buttonsPressed.add(control.name);
      this.buttonsDown.set(control.name, down);
    }
    this.keysTappedSincePoll.clear();
  }

  /** The current value of an analog control: sticks are -1..1, triggers 0..1. */
  value(name) {
    return this.values.get(name) ?? 0;
  }

  /** True only on the frame a button went down. */
  pressed(name) {
    return this.buttonsPressed.has(name);
  }

  usingGamepad() {
    return this.pad !== null;
  }

  /** The raw pad in use this frame (null without one), for ControllerSetup. */
  activePad() { return this.pad; }

  /** Its named controls this frame, after deadzones. */
  activePadState() { return this.padState; }

  /** The layout a pad is read through: the player's own if they made one, else the best built-in fit. */
  layoutFor(pad) {
    if (!this.layouts.has(pad.id)) {
      const custom = this.customLayouts[pad.id];
      this.layouts.set(pad.id, custom ? GamepadLayout.custom(custom) : GamepadLayout.detect(pad));
    }
    return this.layouts.get(pad.id);
  }

  /** Saves a layout the player built for this controller, and starts using it. */
  saveCustomLayout(pad, bindings) {
    this.customLayouts[pad.id] = bindings;
    writeStored(LAYOUTS_KEY, this.customLayouts);
    this.layouts.set(pad.id, GamepadLayout.custom(bindings));
  }

  /** Forgets the player's layout for this controller and goes back to the built-in fit. */
  resetLayout(pad) {
    delete this.customLayouts[pad.id];
    writeStored(LAYOUTS_KEY, this.customLayouts);
    this.layouts.delete(pad.id);
  }

  /** Keys typed into a text box belong to the text box, not to the vehicle. */
  handleKey(event, down) {
    if (down && isTextEntry(event.target)) return;
    if (CAPTURED_KEYS.has(event.code)) event.preventDefault();
    if (down && !event.repeat) this.keysTappedSincePoll.add(event.code);
    if (down) this.keysDown.add(event.code);
    else this.keysDown.delete(event.code);
  }

  anyKeyDown(keys = []) {
    return keys.some(key => this.keysDown.has(key)) ? 1 : 0;
  }

  /** The pad the player touched last; with several connected, any of them can take over by being used. */
  choosePad() {
    if (!navigator.getGamepads) return null;
    const pads = [...navigator.getGamepads()].filter(pad => pad && pad.connected);
    if (pads.length === 0) return null;
    const busy = pads.find(pad => pad.index !== this.activeIndex && this.inUse(pad));
    if (busy) {
      if (this.activeIndex !== null) this.onPadChange?.(`Now using ${gamepadName(busy.id)}.`);
      this.activeIndex = busy.index;
    }
    return pads.find(pad => pad.index === this.activeIndex) ?? pads[0];
  }

  inUse(pad) {
    const state = applyDeadzones(this.layoutFor(pad).read(pad));
    return Object.values(state).some(value => Math.abs(value) > ACTIVITY_THRESHOLD);
  }
}

/** A circular deadzone per stick (so diagonals aren't clipped) and a small one on the triggers. */
function applyDeadzones(state) {
  for (const [xName, yName] of [['leftX', 'leftY'], ['rightX', 'rightY']]) {
    const x = state[xName];
    const y = state[yName];
    const distance = Math.hypot(x, y);
    const scale = distance < STICK_DEADZONE ? 0 : Math.min((distance - STICK_DEADZONE) / (1 - STICK_DEADZONE), 1) / distance;
    state[xName] = x * scale;
    state[yName] = y * scale;
  }
  for (const name of ['leftTrigger', 'rightTrigger']) {
    state[name] = state[name] < TRIGGER_DEADZONE ? 0 : (state[name] - TRIGGER_DEADZONE) / (1 - TRIGGER_DEADZONE);
  }
  return state;
}

function isTextEntry(target) {
  return target instanceof HTMLInputElement && !['checkbox', 'radio', 'range', 'button'].includes(target.type)
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || Boolean(target?.isContentEditable);
}
