import * as THREE from 'three';
import { element } from './dom.js';

const READOUT_INTERVAL_SECONDS = 0.1; // the DOM doesn't need updating every frame
const NEWTONS_PER_METRE = 2500;       // arrow length scale
const MIN_ARROW_NEWTONS = 50;
const ARROW_POOL_SIZE = 32;
const ARROW_COLORS = { suspension: 0x6fe36f, tyre: 0xffa23a, thrust: 0x5fd8ff };
const METRES_PER_SECOND_TO_KMH = 3.6;

const DRIVE_HINTS = {
  gamepad: 'RT go · LT brake/reverse · A handbrake · L3 boost · D-pad ride height · Y rotors · B flip · Back respawn · Start garage · R3 telemetry',
  keyboard: 'W/S go/brake · A/D steer · Space handbrake · B boost · Z/X ride height · F rotors · R flip · Backspace respawn · Esc garage · G tuning · T telemetry',
};
const FLY_HINTS = {
  gamepad: 'Left stick tilt · RT climb · LT descend · LB/RB turn · Y fold rotors',
  keyboard: 'W/A/S/D tilt · Space climb · Shift descend · Q/E turn · F fold rotors',
};
const LOW_CHARGE = 0.15;
const PAD_FLASH_SECONDS = 2;

/**
 * Telemetry: everything the player reads off the screen while driving. The dashboard (speed, power draw, charge,
 * ride height, mode, control hints) is always on; the details view adds a per-wheel table and force arrows.
 * Game updates it each frame; it reads the Vehicle and Controls through their methods.
 */
export class Telemetry {
  root;
  speedValue;
  directionValue;
  powerValue;
  chargeFill;
  rideValue;
  modeLabel;
  hintLine;
  padLabel;
  padSince = 0;
  detailsPanel;
  wheelRows = [];
  arrows = [];
  arrowGroup = new THREE.Group();
  showingDetails = false;
  sinceReadout = 0;

  constructor(hudElement, scene) {
    this.root = hudElement;
    this.buildDashboard();
    this.buildDetails();
    for (let index = 0; index < ARROW_POOL_SIZE; index++) {
      const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 1, 0xffffff, 0.25, 0.15);
      arrow.visible = false;
      this.arrows.push(arrow);
      this.arrowGroup.add(arrow);
    }
    this.arrowGroup.visible = false;
    scene.add(this.arrowGroup);
  }

  /** Shows or hides the whole HUD (it hides in the garage). */
  setVisible(visible) {
    this.root.classList.toggle('hidden', !visible);
    this.arrowGroup.visible = visible && this.showingDetails;
  }

  /** Shows or hides the per-wheel table and force arrows. */
  toggleDetails() {
    this.showingDetails = !this.showingDetails;
    this.detailsPanel.classList.toggle('hidden', !this.showingDetails);
    this.arrowGroup.visible = this.showingDetails;
  }

  /** Flashes the surge-pad notice for a couple of seconds. */
  flashPad() {
    this.padSince = PAD_FLASH_SECONDS;
    this.padLabel.classList.add('active');
  }

  update(vehicle, controls, frameSeconds) {
    if (this.showingDetails) this.drawArrows(vehicle.appliedForces());
    if (this.padSince > 0) {
      this.padSince = Math.max(this.padSince - frameSeconds, 0);
      if (this.padSince === 0) this.padLabel.classList.remove('active');
    }

    this.sinceReadout += frameSeconds;
    if (this.sinceReadout < READOUT_INTERVAL_SECONDS) return;
    this.sinceReadout = 0;

    this.speedValue.textContent = Math.round(vehicle.speed() * METRES_PER_SECOND_TO_KMH);
    this.directionValue.textContent = vehicle.directionLabel();
    this.powerValue.textContent = `${Math.round(vehicle.powerDraw() / 1000)} kW`;
    this.powerValue.classList.toggle('boosting', vehicle.boosting());
    const charge = vehicle.chargeFraction();
    this.chargeFill.style.width = `${charge * 100}%`;
    this.chargeFill.classList.toggle('low', charge < LOW_CHARGE);
    this.rideValue.textContent = `ride ${vehicle.rideHeight().toFixed(2)} m`;
    const flying = vehicle.flying();
    this.modeLabel.textContent = flying ? 'ROTORS' : 'DRIVE';
    this.modeLabel.classList.toggle('flying', flying);
    const hints = flying ? FLY_HINTS : DRIVE_HINTS;
    this.hintLine.textContent = controls.usingGamepad() ? hints.gamepad : hints.keyboard;

    if (this.showingDetails) this.fillWheelTable(vehicle.wheelReadouts());
  }

  drawArrows(forces) {
    let used = 0;
    for (const { force, point, kind } of forces) {
      const newtons = force.length();
      if (newtons < MIN_ARROW_NEWTONS || used >= this.arrows.length) continue;
      const arrow = this.arrows[used++];
      arrow.position.copy(point);
      arrow.setDirection(force.clone().divideScalar(newtons));
      arrow.setLength(Math.max(newtons / NEWTONS_PER_METRE, 0.3), 0.25, 0.15);
      arrow.setColor(ARROW_COLORS[kind]);
      arrow.visible = true;
    }
    for (let index = used; index < this.arrows.length; index++) this.arrows[index].visible = false;
  }

  fillWheelTable(readouts) {
    // Builds can carry any number of wheels; grow the table to match and hide the spare rows.
    while (this.wheelRows.length < readouts.length) this.addWheelRow();
    this.wheelRows.forEach((cells, index) => cells.row.classList.toggle('hidden', index >= readouts.length));
    readouts.forEach((readout, index) => {
      const cells = this.wheelRows[index];
      cells.name.textContent = readout.name;
      cells.load.textContent = readout.inContact ? `${Math.round(readout.load)} N` : '–';
      cells.slip.textContent = readout.inContact ? `${readout.slipDegrees.toFixed(1)}°` : '–';
      cells.surface.textContent = readout.surface;
      cells.row.classList.toggle('sliding', readout.sliding);
    });
  }

  addWheelRow() {
    const row = element('tr', '', this.wheelTable);
    this.wheelRows.push({
      row,
      name: element('td', '', row),
      load: element('td', '', row),
      slip: element('td', '', row),
      surface: element('td', '', row),
    });
  }

  buildDashboard() {
    const dashboard = element('div', 'dashboard', this.root);
    const speed = element('div', 'speed', dashboard);
    this.speedValue = element('span', 'speed-value', speed, '0');
    element('span', 'speed-unit', speed, 'km/h');
    const directionBox = element('div', 'gear', dashboard);
    element('span', 'gear-caption', directionBox, 'drive');
    this.directionValue = element('span', 'gear-value', directionBox, 'D');
    const readouts = element('div', 'dash-readouts', dashboard);
    this.powerValue = element('span', '', readouts, '0 kW');
    this.rideValue = element('span', '', readouts, '');
    const charge = element('div', 'rpm', dashboard);
    this.chargeFill = element('div', 'rpm-fill charge-fill', charge);

    this.modeLabel = element('div', 'mode', this.root, 'DRIVE');
    this.hintLine = element('div', 'hint', this.root, '');
    this.padLabel = element('div', 'pad-flash', this.root, 'SURGE PAD · CHARGING');
  }

  buildDetails() {
    this.detailsPanel = element('div', 'details hidden', this.root);
    element('div', 'details-title', this.detailsPanel, 'Telemetry');
    this.wheelTable = element('table', '', this.detailsPanel);
    const header = element('tr', '', this.wheelTable);
    for (const title of ['Wheel', 'Load', 'Slip', 'Surface']) element('th', '', header, title);
    for (let index = 0; index < 4; index++) this.addWheelRow();
    element('div', 'legend', this.detailsPanel, 'Arrows: green suspension · orange tyre · blue rotor thrust. Highlighted rows are sliding.');
  }
}
