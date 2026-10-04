// How a physical controller's raw buttons and axes become the game's named controls.
//
// Browsers hand over well-known controllers (Xbox, PlayStation, Switch Pro, most recent pads) already in the
// "standard" layout. Everything else arrives raw: button and axis numbers in whatever order the driver uses,
// triggers that rest at −1, D-pads that are a pair of axes or a single "hat" axis. Each GamepadLayout is a
// table of bindings from the game's named controls to those raw inputs.

/** Every named control a layout can bind; sticks read −1..1 (down and right positive), the rest 0..1. */
export const CONTROL_NAMES = [
  'leftX', 'leftY', 'rightX', 'rightY', 'leftTrigger', 'rightTrigger',
  'a', 'b', 'x', 'y', 'leftBumper', 'rightBumper', 'back', 'start', 'leftStickClick', 'rightStickClick',
  'dpadUp', 'dpadDown', 'dpadLeft', 'dpadRight',
];
export const STICK_NAMES = new Set(['leftX', 'leftY', 'rightX', 'rightY']);

// A binding is one of:
//   { button: i }                     a button, 0..1 (analog where the pad has it)
//   { axis: i, scale: ±1 }            a stick axis, −1..1 (scale −1 when it runs the wrong way)
//   { axis: i, sign: ±1 }             one direction of an axis, 0..1 (D-pads on axes, a stick bound in halves)
//   { axis: i, trigger: true }        an analog trigger axis; resting at −1 or 0 is detected, not assumed
//   { hat: i, direction: 'up' | … }   one direction of a single-axis POV hat (DirectInput pads)
// A control may list several bindings; the strongest wins (a trigger's axis and its click, say).

const STANDARD = {
  leftX: [{ axis: 0 }], leftY: [{ axis: 1 }], rightX: [{ axis: 2 }], rightY: [{ axis: 3 }],
  leftTrigger: [{ button: 6 }], rightTrigger: [{ button: 7 }],
  a: [{ button: 0 }], b: [{ button: 1 }], x: [{ button: 2 }], y: [{ button: 3 }],
  leftBumper: [{ button: 4 }], rightBumper: [{ button: 5 }], back: [{ button: 8 }], start: [{ button: 9 }],
  leftStickClick: [{ button: 10 }], rightStickClick: [{ button: 11 }],
  dpadUp: [{ button: 12 }], dpadDown: [{ button: 13 }], dpadLeft: [{ button: 14 }], dpadRight: [{ button: 15 }],
};

// Android-style HID pads on Linux (the Xiaomi dongle among them): axes X, Y, Z, RZ, GAS, BRAKE, HAT0X, HAT0Y and
// fifteen buttons in kernel order A, B, C, X, Y, Z, TL, TR, TL2, TR2, SELECT, START, MODE, THUMBL, THUMBR.
// GAS is the right trigger and BRAKE the left, as on Android.
const ANDROID_HID = {
  leftX: [{ axis: 0 }], leftY: [{ axis: 1 }], rightX: [{ axis: 2 }], rightY: [{ axis: 3 }],
  rightTrigger: [{ axis: 4, trigger: true }, { button: 9 }], leftTrigger: [{ axis: 5, trigger: true }, { button: 8 }],
  a: [{ button: 0 }], b: [{ button: 1 }], x: [{ button: 3 }], y: [{ button: 4 }],
  leftBumper: [{ button: 6 }], rightBumper: [{ button: 7 }], back: [{ button: 10 }], start: [{ button: 11 }],
  leftStickClick: [{ button: 13 }], rightStickClick: [{ button: 14 }],
  dpadUp: [{ axis: 7, sign: -1 }], dpadDown: [{ axis: 7, sign: 1 }], dpadLeft: [{ axis: 6, sign: -1 }], dpadRight: [{ axis: 6, sign: 1 }],
};

// Xbox-style pads through Linux's xpad driver when the browser doesn't recognise them: axes X, Y, Z (left
// trigger), RX, RY, RZ (right trigger), HAT0X, HAT0Y and eleven buttons A, B, X, Y, LB, RB, Back, Start, Guide, L3, R3.
const LINUX_XPAD = {
  leftX: [{ axis: 0 }], leftY: [{ axis: 1 }], rightX: [{ axis: 3 }], rightY: [{ axis: 4 }],
  leftTrigger: [{ axis: 2, trigger: true }], rightTrigger: [{ axis: 5, trigger: true }],
  a: [{ button: 0 }], b: [{ button: 1 }], x: [{ button: 2 }], y: [{ button: 3 }],
  leftBumper: [{ button: 4 }], rightBumper: [{ button: 5 }], back: [{ button: 6 }], start: [{ button: 7 }],
  leftStickClick: [{ button: 9 }], rightStickClick: [{ button: 10 }],
  dpadUp: [{ axis: 7, sign: -1 }], dpadDown: [{ axis: 7, sign: 1 }], dpadLeft: [{ axis: 6, sign: -1 }], dpadRight: [{ axis: 6, sign: 1 }],
};

// Generic DirectInput pads (cheap USB pads on Windows): buttons numbered 1-12 with X, A, B, Y on the face,
// digital triggers as buttons 7 and 8, and the D-pad on a POV hat at axis 9.
const DIRECTINPUT = {
  leftX: [{ axis: 0 }], leftY: [{ axis: 1 }], rightX: [{ axis: 2 }], rightY: [{ axis: 5 }],
  leftTrigger: [{ button: 6 }], rightTrigger: [{ button: 7 }],
  a: [{ button: 1 }], b: [{ button: 2 }], x: [{ button: 0 }], y: [{ button: 3 }],
  leftBumper: [{ button: 4 }], rightBumper: [{ button: 5 }], back: [{ button: 8 }], start: [{ button: 9 }],
  leftStickClick: [{ button: 10 }], rightStickClick: [{ button: 11 }],
  dpadUp: [{ hat: 9, direction: 'up' }], dpadDown: [{ hat: 9, direction: 'down' }],
  dpadLeft: [{ hat: 9, direction: 'left' }], dpadRight: [{ hat: 9, direction: 'right' }],
};

// Built-in layouts, most specific first. `match` sees the raw pad and its parsed vendor/product ids.
const BUILT_IN = [
  { key: 'standard', name: 'Standard', bindings: STANDARD, match: pad => pad.mapping === 'standard' },
  { key: 'xiaomi', name: 'Xiaomi pad', bindings: ANDROID_HID, match: (pad, ids) => ids.vendor === '2717' && pad.buttons.length >= 15 },
  { key: 'androidHid', name: 'Android-style pad', bindings: ANDROID_HID, match: pad => pad.axes.length === 8 && pad.buttons.length === 15 },
  { key: 'linuxXpad', name: 'Xbox-style pad', bindings: LINUX_XPAD, match: pad => pad.axes.length === 8 && pad.buttons.length === 11 },
  { key: 'directInput', name: 'DirectInput pad', bindings: DIRECTINPUT, match: pad => pad.axes.length >= 10 && pad.buttons.length >= 10 },
  { key: 'guess', name: 'Best guess', bindings: STANDARD, match: () => true },
];

const TRIGGER_REST_EVIDENCE = -0.5;   // a trigger axis seen below this rests at −1, not 0
const HAT_TOLERANCE = 0.1;
// A DirectInput POV hat reports eight directions as evenly spaced values from −1 (up), clockwise, to 1 (up-left);
// anything above that is "centred".
const HAT_DIRECTIONS = ['up', 'upRight', 'right', 'downRight', 'down', 'downLeft', 'left', 'upLeft'];
const HAT_PARTS = {
  up: ['up', 'upRight', 'upLeft'], down: ['down', 'downRight', 'downLeft'],
  left: ['left', 'upLeft', 'downLeft'], right: ['right', 'upRight', 'downRight'],
};

/**
 * GamepadLayout: one controller's bindings from named controls to raw buttons and axes, built in or made by
 * the player in ControllerSetup. Controls asks it to read a raw pad every frame. It also learns, per trigger
 * axis, whether that trigger rests at −1 or at 0, because browsers and drivers disagree.
 */
export class GamepadLayout {
  key;
  name;
  bindings;
  custom;
  triggerRestsLow = new Set();   // trigger axes seen resting at −1

  constructor(key, name, bindings, custom = false) {
    this.key = key;
    this.name = name;
    this.bindings = bindings;
    this.custom = custom;
  }

  /** The built-in layout that best fits a raw pad. */
  static detect(pad) {
    const ids = gamepadIds(pad.id);
    const layout = BUILT_IN.find(candidate => candidate.match(pad, ids));
    return new GamepadLayout(layout.key, layout.name, layout.bindings);
  }

  /** A layout the player made, from its saved bindings. */
  static custom(bindings) {
    return new GamepadLayout('custom', 'Custom', bindings, true);
  }

  /** Every named control's value for this raw pad, as { leftX: −1..1, a: 0..1, … }. */
  read(pad) {
    const state = {};
    for (const name of CONTROL_NAMES) state[name] = this.readControl(pad, name);
    return state;
  }

  readControl(pad, name) {
    const bindings = this.bindings[name] ?? [];
    if (STICK_NAMES.has(name)) {
      // A stick axis that runs the wrong way for this pad carries scale −1.
      const binding = bindings[0];
      return binding ? this.readBinding(pad, binding) * (binding.scale ?? 1) : 0;
    }
    return bindings.reduce((strongest, binding) => Math.max(strongest, this.readBinding(pad, binding)), 0);
  }

  readBinding(pad, binding) {
    if (binding.button !== undefined) return pad.buttons[binding.button]?.value ?? 0;
    if (binding.hat !== undefined) return hatPressed(pad.axes[binding.hat], binding.direction) ? 1 : 0;
    const value = pad.axes[binding.axis] ?? 0;
    if (binding.trigger) {
      if (value < TRIGGER_REST_EVIDENCE) this.triggerRestsLow.add(binding.axis);
      return this.triggerRestsLow.has(binding.axis) ? clamp01((value + 1) / 2) : clamp01(value);
    }
    if (binding.sign !== undefined) return clamp01(value * binding.sign);
    return value;
  }

  toJSON() {
    return this.bindings;
  }
}

/** Vendor and product ids from a gamepad id string, in either Chrome's or Firefox's style, as lowercase hex. */
export function gamepadIds(id) {
  const chrome = /Vendor:\s*([0-9a-f]{4})\s*Product:\s*([0-9a-f]{4})/i.exec(id);
  if (chrome) return { vendor: chrome[1].toLowerCase(), product: chrome[2].toLowerCase() };
  const firefox = /^([0-9a-f]{1,4})-([0-9a-f]{1,4})-/i.exec(id);
  if (firefox) return { vendor: firefox[1].padStart(4, '0').toLowerCase(), product: firefox[2].padStart(4, '0').toLowerCase() };
  return { vendor: null, product: null };
}

/** The controller's own name without the browser's vendor/product suffix. */
export function gamepadName(id) {
  return id.replace(/\s*\((STANDARD GAMEPAD\s*)?Vendor:.*\)\s*$/i, '').replace(/^[0-9a-f]{1,4}-[0-9a-f]{1,4}-/i, '').trim() || 'Controller';
}

/** Is a single-axis POV hat held in one of the four directions (diagonals count for both neighbours)? */
function hatPressed(value, direction) {
  if (value === undefined || value > 1 + HAT_TOLERANCE) return false;
  const index = Math.round(((value + 1) / 2) * 7);
  if (Math.abs(-1 + (index * 2) / 7 - value) > HAT_TOLERANCE) return false;
  return HAT_PARTS[direction].includes(HAT_DIRECTIONS[index]);
}

function clamp01(value) {
  return Math.min(Math.max(value, 0), 1);
}
