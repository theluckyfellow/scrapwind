import { CONTROL_NAMES, gamepadName } from './GamepadLayout.js';
import { element, button } from './dom.js';

// The wizard's steps, in the order a player can comfortably do them. `kind` decides how a raw input
// becomes a binding: buttons, triggers (analog, either resting at −1 or 0), D-pad directions, stick axes.
const STEPS = [
  { control: 'a', kind: 'button', prompt: 'Press A — the bottom face button.' },
  { control: 'b', kind: 'button', prompt: 'Press B — the right face button.' },
  { control: 'x', kind: 'button', prompt: 'Press X — the left face button.' },
  { control: 'y', kind: 'button', prompt: 'Press Y — the top face button.' },
  { control: 'leftBumper', kind: 'button', prompt: 'Press the left bumper (the upper left shoulder button).' },
  { control: 'rightBumper', kind: 'button', prompt: 'Press the right bumper.' },
  { control: 'leftTrigger', kind: 'trigger', prompt: 'Squeeze the left trigger all the way.' },
  { control: 'rightTrigger', kind: 'trigger', prompt: 'Squeeze the right trigger all the way.' },
  { control: 'back', kind: 'button', prompt: 'Press Back (also called Select, View or Share).' },
  { control: 'start', kind: 'button', prompt: 'Press Start (also called Menu or Options).' },
  { control: 'leftStickClick', kind: 'button', prompt: 'Click the left stick in.' },
  { control: 'rightStickClick', kind: 'button', prompt: 'Click the right stick in.' },
  { control: 'dpadUp', kind: 'dpad', direction: 'up', prompt: 'Press up on the D-pad.' },
  { control: 'dpadDown', kind: 'dpad', direction: 'down', prompt: 'Press down on the D-pad.' },
  { control: 'dpadLeft', kind: 'dpad', direction: 'left', prompt: 'Press left on the D-pad.' },
  { control: 'dpadRight', kind: 'dpad', direction: 'right', prompt: 'Press right on the D-pad.' },
  { control: 'leftX', kind: 'stick', prompt: 'Push the left stick all the way right.' },
  { control: 'leftY', kind: 'stick', prompt: 'Push the left stick all the way down.' },
  { control: 'rightX', kind: 'stick', prompt: 'Push the right stick all the way right.' },
  { control: 'rightY', kind: 'stick', prompt: 'Push the right stick all the way down.' },
];

// What each control does in the game, for the reference list.
const ACTIONS = [
  ['Left stick', ['leftX', 'leftY'], 'Steer · tilt in the air and in flight'],
  ['Right trigger', ['rightTrigger'], 'Drive · climb in flight'],
  ['Left trigger', ['leftTrigger'], 'Brake, then reverse · descend in flight'],
  ['A', ['a'], 'Handbrake'],
  ['X', ['x'], 'Boost (left stick click too)'],
  ['Y', ['y'], 'Unfold or fold the rotors'],
  ['B', ['b'], 'Flip back onto your wheels'],
  ['Bumpers', ['leftBumper', 'rightBumper'], 'Turn while flying'],
  ['D-pad up / down', ['dpadUp', 'dpadDown'], 'Raise or lower the ride height'],
  ['Right stick', ['rightX', 'rightY'], 'Look around'],
  ['Back', ['back'], 'Back to the start'],
  ['Start', ['start'], 'Back to the garage'],
  ['Right stick click', ['rightStickClick'], 'Telemetry'],
];

const PRESS_THRESHOLD = 0.6;      // how far a button or axis must move from rest to be captured
const REST_THRESHOLD = 0.25;      // everything must be back within this of rest before the next step
const HAT_NEUTRAL = 1.05;         // a single-axis POV hat rests above 1
const HAT_DIRECTIONS = ['up', 'upRight', 'right', 'downRight', 'down', 'downLeft', 'left', 'upLeft'];

/**
 * ControllerSetup: the garage's controller screen. Shows the connected pad as a live diagram, says what each
 * control does in the game, and runs a rebind wizard that learns a layout by asking for one control at a
 * time and watching which raw button or axis moves. Reads the pad through Controls and saves the finished
 * layout there; Game opens it from the garage and updates it each frame while it is open.
 */
export class ControllerSetup {
  controls;
  root;
  open = false;
  // Live diagram parts, keyed by control name.
  lamps = new Map();
  sticks = {};
  triggers = {};
  title;
  layoutLine;
  actionRows = [];
  wizardPanel;
  wizardPrompt;
  wizardProgress;
  wizardFeedback;
  idlePanel;
  rawPanel;
  // Wizard state.
  stepIndex = -1;
  rest = null;                // the raw pad, idle, as it was when the wizard started
  waitingForRelease = false;
  captured = {};

  constructor(parent, controls) {
    this.controls = controls;
    this.root = element('div', 'controller-setup hidden', parent);
    const card = element('div', 'controller-card', this.root);
    const header = element('div', 'controller-header', card);
    this.title = element('div', 'controller-title', header, 'Controller');
    button('controller-close', header, '×', () => this.close());
    this.layoutLine = element('div', 'controller-layout', card);
    this.buildDiagram(element('div', 'controller-diagram', card));
    this.buildIdlePanel(card);
    this.buildWizardPanel(card);
    const rawDetails = element('details', 'controller-raw', card);
    element('summary', '', rawDetails, 'Raw input');
    this.rawPanel = element('pre', '', rawDetails);
    this.root.addEventListener('pointerdown', event => {
      if (event.target === this.root) this.close();
    });
  }

  show() {
    this.open = true;
    this.root.classList.remove('hidden');
    this.update();
  }

  close() {
    this.open = false;
    this.stepIndex = -1;
    this.root.classList.add('hidden');
  }

  isOpen() { return this.open; }

  /** Redraws the live diagram and advances the wizard; Game calls this every frame while open. */
  update() {
    if (!this.open) return;
    const pad = this.controls.activePad();
    const state = this.controls.activePadState();
    this.title.textContent = pad ? gamepadName(pad.id) : 'No controller yet';
    this.layoutLine.textContent = pad
      ? `${this.controls.layoutFor(pad).name} layout · ${pad.mapping === 'standard' ? 'recognised by the browser' : 'raw input, read through the layout'}`
      : 'Plug a controller in and press any button on it. Browsers only reveal a controller after it has been pressed.';
    this.drawState(state);
    this.drawRaw(pad);
    if (this.stepIndex >= 0) this.stepWizard(pad);
    this.idlePanel.classList.toggle('hidden', this.stepIndex >= 0);
    this.wizardPanel.classList.toggle('hidden', this.stepIndex < 0);
  }

  drawState(state) {
    for (const [name, lamp] of this.lamps) lamp.classList.toggle('lit', Boolean(state && state[name] > 0.5));
    for (const side of ['left', 'right']) {
      const x = state ? state[`${side}X`] : 0;
      const y = state ? state[`${side}Y`] : 0;
      this.sticks[side].style.transform = `translate(${x * 18}px, ${y * 18}px)`;
      this.triggers[side].style.height = `${(state ? state[`${side}Trigger`] : 0) * 100}%`;
    }
    for (const row of this.actionRows) {
      const active = Boolean(state && row.controls.some(name => Math.abs(state[name]) > 0.5));
      row.node.classList.toggle('lit', active);
    }
  }

  drawRaw(pad) {
    if (!this.rawPanel.parentElement.open) return;
    if (!pad) {
      this.rawPanel.textContent = '—';
      return;
    }
    const axes = pad.axes.map((value, index) => `axis ${index}: ${value.toFixed(2)}`).join('\n');
    const buttons = pad.buttons.map((entry, index) => `${index}:${entry.pressed ? '■' : '·'}`).join(' ');
    this.rawPanel.textContent = `${pad.id}\nmapping: ${pad.mapping || '(none)'}\n\n${axes}\n\nbuttons ${buttons}`;
  }

  // ---- The rebind wizard ----

  startWizard() {
    if (!this.controls.activePad()) {
      this.wizardFeedbackText('Press any button on the controller first, so the browser lets the game see it.');
      return;
    }
    const pad = this.controls.activePad();
    this.captured = {};
    this.stepIndex = 0;
    this.rest = { axes: [...pad.axes], buttons: pad.buttons.map(entry => entry.value) }; // the pad idle, as it is now
    this.waitingForRelease = true;
    this.showStep();
  }

  skipStep() {
    this.captured[STEPS[this.stepIndex].control] = [];
    this.nextStep('Skipped.');
  }

  cancelWizard() {
    this.stepIndex = -1;
    for (const node of this.highlightable()) node.classList.remove('wanted');
  }

  showStep() {
    const step = STEPS[this.stepIndex];
    this.wizardPrompt.textContent = step.prompt;
    this.wizardProgress.textContent = `${this.stepIndex + 1} of ${STEPS.length}`;
    const wanted = this.diagramPartFor(step.control);
    for (const node of this.highlightable()) node.classList.toggle('wanted', node === wanted);
  }

  /** The diagram part that shows a control: its lamp, or the trigger track or stick well for analog ones. */
  diagramPartFor(control) {
    const side = control.startsWith('left') ? 'left' : 'right';
    if (control.endsWith('Trigger')) return this.triggers[side].parentElement;
    if (/^(left|right)[XY]$/.test(control)) return this.sticks[side].parentElement;
    return this.lamps.get(control);
  }

  highlightable() {
    return [...this.lamps.values(), this.triggers.left.parentElement, this.triggers.right.parentElement];
  }

  nextStep(feedback) {
    this.wizardFeedbackText(feedback);
    this.stepIndex++;
    this.waitingForRelease = true;
    if (this.stepIndex >= STEPS.length) {
      this.finishWizard();
      return;
    }
    this.showStep();
  }

  finishWizard() {
    const pad = this.controls.activePad();
    const bindings = {};
    for (const name of CONTROL_NAMES) bindings[name] = this.captured[name] ?? [];
    if (pad) this.controls.saveCustomLayout(pad, bindings);
    this.stepIndex = -1;
    for (const node of this.highlightable()) node.classList.remove('wanted');
    this.wizardFeedbackText('Saved. This controller now uses your layout; "Use built-in layout" undoes it.');
  }

  /** Waits for everything to be let go, then watches for the asked-for input. */
  stepWizard(pad) {
    if (!pad) return;
    const snapshot = { axes: [...pad.axes], buttons: pad.buttons.map(entry => entry.value) };
    if (this.waitingForRelease) {
      this.waitingForRelease = !this.isAtRest(snapshot, this.rest);
      return;
    }
    const binding = this.capture(STEPS[this.stepIndex], snapshot);
    if (!binding) return;
    this.captured[STEPS[this.stepIndex].control] = [binding];
    this.nextStep(`Got it: ${describe(binding)}.`);
  }

  isAtRest(snapshot, rest) {
    return snapshot.buttons.every((value, index) => Math.abs(value - (rest.buttons[index] ?? 0)) < REST_THRESHOLD)
      && snapshot.axes.every((value, index) => Math.abs(value - (rest.axes[index] ?? 0)) < REST_THRESHOLD);
  }

  /** The binding the player just made for a step, or null while nothing has clearly moved yet. */
  capture(step, snapshot) {
    let best = null;
    snapshot.buttons.forEach((value, index) => {
      const change = value - (this.rest.buttons[index] ?? 0);
      if (change > PRESS_THRESHOLD && (!best || change > best.strength)) best = { strength: change, button: index };
    });
    snapshot.axes.forEach((value, index) => {
      const restValue = this.rest.axes[index] ?? 0;
      const change = value - restValue;
      if (Math.abs(change) > PRESS_THRESHOLD && (!best || Math.abs(change) > best.strength)) {
        best = { strength: Math.abs(change), axis: index, value, restValue, change };
      }
    });
    if (!best) return null;
    if (best.button !== undefined) return step.kind === 'stick' ? null : { button: best.button };

    const { axis, value, restValue, change } = best;
    if (step.kind === 'stick') return { axis, scale: Math.sign(change) };
    if (step.kind === 'trigger') return restValue < -0.5 ? { axis, trigger: true } : { axis, sign: Math.sign(change) };
    if (step.kind === 'dpad' && restValue > HAT_NEUTRAL) {
      const index = Math.round(((value + 1) / 2) * 7);
      return HAT_DIRECTIONS[index]?.toLowerCase().includes(step.direction) ? { hat: axis, direction: step.direction } : null;
    }
    return { axis, sign: Math.sign(change) };
  }

  wizardFeedbackText(text) {
    this.wizardFeedback.textContent = text;
  }

  // ---- Building the card ----

  buildDiagram(diagram) {
    const shoulders = element('div', 'pad-shoulders', diagram);
    for (const side of ['left', 'right']) {
      const group = element('div', `pad-shoulder ${side}`, shoulders);
      const track = element('div', 'pad-trigger', group);
      this.triggers[side] = element('div', 'pad-trigger-fill', track);
      element('span', 'pad-trigger-label', group, side === 'left' ? 'LT' : 'RT');
      this.lamp(group, `${side}Bumper`, side === 'left' ? 'LB' : 'RB', 'pad-bumper');
    }
    const face = element('div', 'pad-face', diagram);
    const left = element('div', 'pad-cluster', face);
    this.stick(left, 'left');
    const dpad = element('div', 'pad-dpad', left);
    for (const [name, label] of [['dpadUp', '▲'], ['dpadLeft', '◀'], ['dpadRight', '▶'], ['dpadDown', '▼']]) {
      this.lamp(dpad, name, label, `pad-dpad-key ${name}`);
    }
    const middle = element('div', 'pad-middle', face);
    this.lamp(middle, 'back', 'Back', 'pad-pill');
    this.lamp(middle, 'start', 'Start', 'pad-pill');
    const right = element('div', 'pad-cluster', face);
    const buttons = element('div', 'pad-buttons', right);
    for (const name of ['y', 'x', 'b', 'a']) this.lamp(buttons, name, name.toUpperCase(), `pad-face-button ${name}`);
    this.stick(right, 'right');
  }

  stick(parent, side) {
    const well = element('div', 'pad-stick-well', parent);
    this.lamps.set(`${side}StickClick`, well);
    this.sticks[side] = element('div', 'pad-stick', well);
  }

  lamp(parent, name, label, className) {
    const node = element('div', `pad-lamp ${className}`, parent, label);
    this.lamps.set(name, node);
    return node;
  }

  buildIdlePanel(card) {
    this.idlePanel = element('div', 'controller-idle', card);
    const list = element('div', 'controller-actions', this.idlePanel);
    for (const [label, controls, action] of ACTIONS) {
      const node = element('div', 'controller-action', list);
      element('span', 'controller-action-key', node, label);
      element('span', 'controller-action-what', node, action);
      this.actionRows.push({ node, controls });
    }
    const buttons = element('div', 'controller-buttons', this.idlePanel);
    button('controller-primary', buttons, 'Rebind every control', () => this.startWizard());
    button('', buttons, 'Use built-in layout', () => {
      const pad = this.controls.activePad();
      if (pad) this.controls.resetLayout(pad);
      this.wizardFeedbackText(pad ? 'Back to the built-in layout.' : 'No controller to reset.');
    });
    this.wizardFeedback = element('div', 'controller-feedback', card);
  }

  buildWizardPanel(card) {
    this.wizardPanel = element('div', 'controller-wizard hidden', card);
    this.wizardProgress = element('div', 'controller-progress', this.wizardPanel);
    this.wizardPrompt = element('div', 'controller-prompt', this.wizardPanel);
    element('div', 'controller-note', this.wizardPanel, 'Let go of everything between steps. Missing a control on this pad? Skip it.');
    const buttons = element('div', 'controller-buttons', this.wizardPanel);
    button('', buttons, 'Skip', () => this.skipStep());
    button('', buttons, 'Cancel', () => this.cancelWizard());
  }
}

function describe(binding) {
  if (binding.button !== undefined) return `button ${binding.button}`;
  if (binding.hat !== undefined) return `hat ${binding.hat} ${binding.direction}`;
  if (binding.trigger) return `axis ${binding.axis} (trigger)`;
  if (binding.scale !== undefined) return `axis ${binding.axis}${binding.scale < 0 ? ', reversed' : ''}`;
  return `axis ${binding.axis} ${binding.sign > 0 ? '+' : '−'}`;
}
