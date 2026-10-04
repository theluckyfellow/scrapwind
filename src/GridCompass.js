import * as THREE from 'three';
import { element } from './dom.js';

const HALF_FIELD = THREE.MathUtils.degToRad(80);  // the strip spans this either side of straight ahead
const REFRESH_SECONDS = 1 / 15;
const TITLE_SECONDS = 14;
const LABEL_GAP = 9;      // % of the strip; a distance label closer than this to a more important one is hidden

/**
 * GridCompass: the grid on screen. A compass strip along the top marks every relay by bearing and
 * distance (amber for ones you can wake, pinned to the strip's edge when they're behind you; teal for
 * lit; grey for out of reach), a panel appears near a relay to say what it needs and fill as you
 * charge it, and a title card marks the night the Spire wakes. Game updates it each frame from the Grid
 * and the camera.
 */
export class GridCompass {
  root;
  strip;
  markers = new Map();     // relay → { node, label }
  tally;
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

  update(grid, camera, vehiclePosition, frameSeconds) {
    if (this.titleShownFor !== null) {
      this.titleShownFor += frameSeconds;
      if (this.titleShownFor > TITLE_SECONDS) this.hideTitle();
    }
    this.sinceRefresh += frameSeconds;
    if (this.sinceRefresh < REFRESH_SECONDS) return;
    this.sinceRefresh = 0;

    const look = camera.getWorldDirection(new THREE.Vector3());
    const heading = Math.atan2(look.x, -look.z);
    const shown = [];
    for (const [relay, { node, label }] of this.markers) {
      const dx = relay.station.x - vehiclePosition.x;
      const dz = relay.station.z - vehiclePosition.z;
      const bearing = Math.atan2(dx, -dz);
      const offset = Math.atan2(Math.sin(bearing - heading), Math.cos(bearing - heading));
      const waiting = grid.canLight(relay);
      const behind = Math.abs(offset) > HALF_FIELD;
      node.classList.toggle('lit', relay.isLit());
      node.classList.toggle('waiting', waiting);
      node.classList.toggle('pinned', behind && waiting);
      node.style.display = behind && !waiting ? 'none' : '';
      const left = 50 + THREE.MathUtils.clamp(offset / HALF_FIELD, -1, 1) * 50;
      node.style.left = `${left}%`;
      const distance = Math.hypot(dx, dz);
      label.textContent = distance < 1000 ? `${Math.round(distance)} m` : `${(distance / 1000).toFixed(1)} km`;
      if (!behind || waiting) shown.push({ label, left, distance, waiting });
    }
    this.declutterLabels(shown);
    this.tally.textContent = `Grid ${grid.litCount()} / ${grid.total()}`;
    this.updatePanel(grid.nearby(vehiclePosition));
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

  updatePanel(near) {
    this.panel.classList.toggle('hidden', !near);
    if (!near) return;
    const { relay, lit, canLight, delivered, cost, charging, litNeeded } = near;
    this.panelTitle.textContent = relay.definition.title;
    this.panelName.textContent = relay.definition.name;
    this.panel.classList.toggle('lit', lit);
    this.panel.classList.toggle('charging', charging);
    this.panelFill.style.width = `${Math.min(delivered / cost, 1) * 100}%`;
    let status;
    if (lit) status = 'Awake. Park on the plate to recharge.';
    else if (relay.definition.finale && !canLight) status = `The Spire wants the whole grid: ${litNeeded} relay${litNeeded === 1 ? '' : 's'} still dark.`;
    else if (!canLight) status = 'Dead. Wake a neighbouring relay first, so power can reach it.';
    else if (charging) status = `Feeding the relay… ${Math.round(delivered)} / ${cost} Wh`;
    else status = `Stop on the plate to feed it ${Math.round(cost - delivered)} Wh of charge.`;
    this.panelStatus.textContent = status;
  }
}
