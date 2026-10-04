import * as THREE from 'three';
import { element } from './dom.js';

const HALF_FIELD = THREE.MathUtils.degToRad(80);  // the strip spans this either side of straight ahead
const REFRESH_SECONDS = 1 / 15;
const TITLE_SECONDS = 14;
const LABEL_GAP = 9;      // % of the strip; a distance label closer than this to a more important one is hidden
const LOW_CHARGE = 0.25;  // below this much battery, the HUD points the way to the nearest charger

/**
 * GridCompass: the grid on screen. A compass strip along the top marks every relay by bearing and
 * distance (amber for ones you can wake, pinned to the strip's edge when they're behind you; teal for
 * lit; grey for out of reach), a panel appears near a relay to say what it needs (or how your charge is
 * coming along on a lit one), a hint points the way to a charger when the batteries run low, and a title
 * card marks the night the Spire wakes. Game updates it each frame from the Grid, the camera and the Vehicle.
 */
export class GridCompass {
  root;
  strip;
  markers = new Map();     // relay → { node, label }
  tally;
  lowChargeHint;
  panel;
  panelTitle;
  panelName;
  panelStatus;
  panelFill;
  titleCard;
  titleBy;
  sinceRefresh = 0;
  titleShownFor = null;    // seconds the title card has been up, null while hidden

  constructor(parent, grid) {
    this.root = element('div', 'grid-hud', parent);
    this.strip = element('div', 'grid-strip', this.root);
    element('div', 'grid-strip-centre', this.strip);
    for (const relay of grid.relayList()) {
      const node = element('div', 'grid-marker', this.strip);
      element('div', 'grid-diamond', node);
      const label = element('div', 'grid-marker-label', node);
      this.markers.set(relay, { node, label });
    }
    this.tally = element('div', 'grid-tally', this.root);
    this.lowChargeHint = element('div', 'grid-low-charge hidden', this.root);

    this.panel = element('div', 'grid-panel hidden', this.root);
    const heading = element('div', 'grid-panel-heading', this.panel);
    this.panelTitle = element('span', 'grid-panel-title', heading);
    this.panelName = element('span', 'grid-panel-name', heading);
    this.panelStatus = element('div', 'grid-panel-status', this.panel);
    const bar = element('div', 'grid-panel-bar', this.panel);
    this.panelFill = element('div', 'grid-panel-fill', bar);

    this.titleCard = element('div', 'grid-title hidden', parent);
    element('div', 'grid-title-chinese', this.titleCard, '山谷记得');
    element('div', 'grid-title-main', this.titleCard, 'The valley remembers');
    element('div', 'grid-title-line', this.titleCard, 'Twelve relays and the Spire, awake. 拾风 has power again.');
    this.titleBy = element('div', 'grid-title-line', this.titleCard);
    this.titleCard.addEventListener('pointerdown', () => this.hideTitle());
  }

  setVisible(visible) {
    this.root.classList.toggle('hidden', !visible);
    if (!visible) this.hideTitle();
  }

  /** The finale's title card, naming the crewmate who finished it if it wasn't you; it fades by itself or on a click. */
  showTitle(by = null) {
    this.titleBy.textContent = by ? `${by} woke the Spire.` : '';
    this.titleShownFor = 0;
    this.titleCard.classList.remove('hidden');
    this.root.classList.add('quiet');
  }

  hideTitle() {
    this.titleShownFor = null;
    this.titleCard.classList.add('hidden');
    this.root.classList.remove('quiet');
  }

  update(grid, camera, vehicle, frameSeconds) {
    if (this.titleShownFor !== null) {
      this.titleShownFor += frameSeconds;
      if (this.titleShownFor > TITLE_SECONDS) this.hideTitle();
    }
    this.sinceRefresh += frameSeconds;
    if (this.sinceRefresh < REFRESH_SECONDS) return;
    this.sinceRefresh = 0;

    const vehiclePosition = vehicle.drawnPosition();
    const charge = vehicle.chargeFraction();
    const charger = charge < LOW_CHARGE ? grid.nearestCharger(vehiclePosition) : null;
    const look = camera.getWorldDirection(new THREE.Vector3());
    const heading = Math.atan2(look.x, -look.z);
    const shown = [];
    for (const [relay, { node, label }] of this.markers) {
      const dx = relay.station.x - vehiclePosition.x;
      const dz = relay.station.z - vehiclePosition.z;
      const bearing = Math.atan2(dx, -dz);
      const offset = Math.atan2(Math.sin(bearing - heading), Math.cos(bearing - heading));
      const waiting = grid.canLight(relay);
      const recharge = relay === charger?.relay;
      const important = waiting || recharge;   // worth pinning to the strip's edge when it's behind you
      const behind = Math.abs(offset) > HALF_FIELD;
      node.classList.toggle('lit', relay.isLit());
      node.classList.toggle('waiting', waiting);
      node.classList.toggle('recharge', recharge);
      node.classList.toggle('pinned', behind && important);
      node.style.display = behind && !important ? 'none' : '';
      const left = 50 + THREE.MathUtils.clamp(offset / HALF_FIELD, -1, 1) * 50;
      node.style.left = `${left}%`;
      const distance = Math.hypot(dx, dz);
      label.textContent = distance < 1000 ? `${Math.round(distance)} m` : `${(distance / 1000).toFixed(1)} km`;
      if (!behind || important) shown.push({ label, left, distance, waiting: important });
    }
    this.declutterLabels(shown);
    this.tally.textContent = `Grid ${grid.litCount()} / ${grid.total()}`;
    const near = grid.nearby(vehiclePosition);
    this.updatePanel(near, charge, vehicle.batteryCapacity());
    this.updateLowChargeHint(charger, charge, near?.lit && near.onPlate);
  }

  /** Running low and not already on a charger: say where the nearest one is. */
  updateLowChargeHint(charger, charge, charging) {
    const show = Boolean(charger) && !charging;
    this.lowChargeHint.classList.toggle('hidden', !show);
    if (!show) return;
    const { relay, distance } = charger;
    const away = distance < 1000 ? `${Math.round(distance)} m` : `${(distance / 1000).toFixed(1)} km`;
    this.lowChargeHint.textContent = `Battery ${Math.round(charge * 100)}% · charge on the plate at ${relay.definition.title} ${relay.definition.name}, ${away} ⚡ · or respawn charged`;
  }

  /** Relays you can wake keep their labels first, then the nearest; labels that would overlap a kept one hide. */
  declutterLabels(shown) {
    shown.sort((a, b) => (b.waiting - a.waiting) || (a.distance - b.distance));
    const kept = [];
    for (const { label, left } of shown) {
      const crowded = kept.some(other => Math.abs(other - left) < LABEL_GAP);
      label.classList.toggle('crowded', crowded);
      if (!crowded) kept.push(left);
    }
  }

  /** Near a relay: what it needs from you, or, on a lit one, how your own charge is coming along. */
  updatePanel(near, charge, capacity) {
    this.panel.classList.toggle('hidden', !near);
    if (!near) return;
    const { relay, lit, canLight, delivered, cost, charging, onPlate, stationWatts, litNeeded } = near;
    this.panelTitle.textContent = relay.definition.title;
    this.panelName.textContent = relay.definition.name;
    this.panel.classList.toggle('lit', lit);
    this.panel.classList.toggle('charging', charging || stationWatts > 0);
    // On a lit relay the bar is your battery; on a dark one it is the relay's.
    this.panelFill.style.width = `${(lit ? charge : Math.min(delivered / cost, 1)) * 100}%`;
    const percent = `${Math.round(charge * 100)}%`;
    let status;
    if (lit && stationWatts > 0) status = `Charging · battery ${percent} · full in ${Math.ceil(((1 - charge) * capacity * 3600) / stationWatts)} s`;
    else if (lit && onPlate) status = `Charged · battery ${percent}. Off you go.`;
    else if (lit) status = `Awake. Park on its plate to charge (battery ${percent}).`;
    else if (relay.definition.finale && !canLight) status = `The Spire wants the whole grid: ${litNeeded} relay${litNeeded === 1 ? '' : 's'} still dark.`;
    else if (!canLight) status = 'Dead. Wake a neighbouring relay first, so power can reach it.';
    else if (charging) status = `Feeding the relay… ${Math.round(delivered)} / ${cost} Wh`;
    else status = `Stop on the plate to feed it ${Math.round(cost - delivered)} Wh of charge.`;
    this.panelStatus.textContent = status;
  }
}
