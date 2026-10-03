// What every control does, for a standard-layout gamepad and the keyboard.
// Analog controls take whichever of the two is pushed further. Driving and flying share some
// controls (the right trigger is both throttle and climb); Vehicle uses the ones its mode needs.
const STICK_DEADZONE = 0.15;
const GAMEPAD = {
  leftStickX: 0, leftStickY: 1, rightStickX: 2, rightStickY: 3,
  a: 0, b: 1, x: 2, y: 3, leftBumper: 4, rightBumper: 5, leftTrigger: 6, rightTrigger: 7,
  back: 8, start: 9, dpadUp: 12,
};

const ANALOG_CONTROLS = [
  { name: 'steer', pad: pad => stick(pad, GAMEPAD.leftStickX), positiveKeys: ['KeyD', 'ArrowRight'], negativeKeys: ['KeyA', 'ArrowLeft'] },
  { name: 'throttle', pad: pad => trigger(pad, GAMEPAD.rightTrigger), positiveKeys: ['KeyW', 'ArrowUp'] },
  { name: 'brake', pad: pad => trigger(pad, GAMEPAD.leftTrigger), positiveKeys: ['KeyS', 'ArrowDown'] },
  { name: 'handbrake', pad: pad => trigger(pad, GAMEPAD.a), positiveKeys: ['Space'] },
  { name: 'tiltForward', pad: pad => -stick(pad, GAMEPAD.leftStickY), positiveKeys: ['KeyW', 'ArrowUp'], negativeKeys: ['KeyS', 'ArrowDown'] },
  { name: 'tiltRight', pad: pad => stick(pad, GAMEPAD.leftStickX), positiveKeys: ['KeyD', 'ArrowRight'], negativeKeys: ['KeyA', 'ArrowLeft'] },
  { name: 'climb', pad: pad => trigger(pad, GAMEPAD.rightTrigger), positiveKeys: ['Space'] },
  { name: 'descend', pad: pad => trigger(pad, GAMEPAD.leftTrigger), positiveKeys: ['ShiftLeft', 'ShiftRight'] },
  { name: 'yaw', pad: pad => trigger(pad, GAMEPAD.rightBumper) - trigger(pad, GAMEPAD.leftBumper), positiveKeys: ['KeyE'], negativeKeys: ['KeyQ'] },
  { name: 'lookRight', pad: pad => stick(pad, GAMEPAD.rightStickX), positiveKeys: ['KeyL'], negativeKeys: ['KeyJ'] },
  { name: 'lookUp', pad: pad => -stick(pad, GAMEPAD.rightStickY), positiveKeys: ['KeyI'], negativeKeys: ['KeyK'] },
];

const BUTTON_CONTROLS = [
  { name: 'toggleRotors', padButton: GAMEPAD.y, keys: ['KeyF'] },
  { name: 'flipUpright', padButton: GAMEPAD.b, keys: ['KeyR'] },
  { name: 'respawn', padButton: GAMEPAD.back, keys: ['Backspace'] },
  { name: 'toggleTuning', padButton: GAMEPAD.start, keys: ['KeyG'] },
  { name: 'toggleTelemetry', padButton: GAMEPAD.dpadUp, keys: ['KeyT'] },
];

// Keys the browser would otherwise use to scroll or navigate.
const CAPTURED_KEYS = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace']);

/**
 * Controls: one record of what the player is asking for this frame, filled from the first connected
 * gamepad and the keyboard. Game polls it once per frame; Vehicle and ChaseCamera read values by name,
 * and Game checks one-shot buttons with pressed().
 */
export class Controls {
  keysDown = new Set();
  keysTappedSincePoll = new Set(); // a tap can go down and up between two polls; this keeps it from being lost
  values = new Map();         // analog control name → -1..1 or 0..1
  buttonsDown = new Map();    // button control name → held this frame
  buttonsPressed = new Set(); // button control names that went down this frame
  gamepadId = null;

  constructor(target) {
    target.addEventListener('keydown', event => this.handleKey(event, true));
    target.addEventListener('keyup', event => this.handleKey(event, false));
    target.addEventListener('blur', () => this.keysDown.clear());
  }

  /** Reads the gamepad and keyboard; call once per frame before anything asks for values. */
  poll() {
    const pad = firstGamepad();
    this.gamepadId = pad ? pad.id : null;

    for (const control of ANALOG_CONTROLS) {
      const keyboard = this.anyKeyDown(control.positiveKeys) - this.anyKeyDown(control.negativeKeys);
      const gamepad = pad ? control.pad(pad) : 0;
      this.values.set(control.name, Math.abs(keyboard) > Math.abs(gamepad) ? keyboard : gamepad);
    }

    this.buttonsPressed.clear();
    for (const control of BUTTON_CONTROLS) {
      const down = this.anyKeyDown(control.keys) === 1 || Boolean(pad?.buttons[control.padButton]?.pressed);
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
    return this.gamepadId !== null;
  }

  handleKey(event, down) {
    if (CAPTURED_KEYS.has(event.code)) event.preventDefault();
    if (down && !event.repeat) this.keysTappedSincePoll.add(event.code);
    if (down) this.keysDown.add(event.code);
    else this.keysDown.delete(event.code);
  }

  anyKeyDown(keys = []) {
    return keys.some(key => this.keysDown.has(key)) ? 1 : 0;
  }
}

function firstGamepad() {
  if (!navigator.getGamepads) return null;
  for (const pad of navigator.getGamepads()) {
    if (pad && pad.connected) return pad;
  }
  return null;
}

function stick(pad, axis) {
  const value = pad.axes[axis] ?? 0;
  const magnitude = Math.abs(value);
  if (magnitude < STICK_DEADZONE) return 0;
  return Math.sign(value) * (magnitude - STICK_DEADZONE) / (1 - STICK_DEADZONE);
}

function trigger(pad, button) {
  return pad.buttons[button]?.value ?? 0;
}
