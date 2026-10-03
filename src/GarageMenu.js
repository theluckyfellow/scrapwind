import { BODIES, WHEELS, BATTERIES, ROTORS, PANEL_SLOTS, PAINTS, RIDE_HEIGHT_RANGE } from './catalog.js';
import { Blueprint } from './Blueprint.js';
import { PRESETS } from './presets.js';
import { element, button, downloadText } from './dom.js';

const SAVED_DESIGNS_KEY = 'scrapwind-designs';
const ARM_SECONDS = 3;     // a body switch that would clear parts waits this long for a second click

const PART_GROUPS = [
  { part: 'wheel', title: 'Wheel units', models: WHEELS, detail: model => `${model.radius * 2} m · ${kilowatts(model.motorPower)} kW motor` },
  { part: 'battery', title: 'Batteries', models: BATTERIES, detail: model => `${model.capacity / 1000} kWh · ${kilowatts(model.maxPower)} kW · ${model.mass} kg` },
  { part: 'rotor', title: 'Rotors', models: ROTORS, detail: model => `${(model.maxThrust / 1000).toFixed(1)} kN lift · ${model.mass} kg` },
];

const STAT_ROWS = [
  ['Mass', stats => `${Math.round(stats.mass)} kg`],
  ['Weight front / rear', stats => `${Math.round(stats.frontShare * 100)} / ${Math.round((1 - stats.frontShare) * 100)}`],
  ['Motors', stats => `${kilowatts(stats.wheelPower)} kW`],
  ['Batteries', stats => `${kilowatts(stats.batteryPower)} kW · ${(stats.capacity / 1000).toFixed(1)} kWh`],
  ['Top speed', stats => `${Math.round(stats.topSpeed * 3.6)} km/h`],
  ['Range at 60 km/h', stats => `${Math.round(stats.rangeKilometres)} km`],
  ['Rotor lift', stats => (stats.rotorCount ? `${Math.round(stats.lift * 100)}% of weight` : 'no rotors')],
  ['Hover time', stats => (stats.rotorCount ? (stats.hoverMinutes > 0 ? `${stats.hoverMinutes.toFixed(1)} min` : "can't hover") : '–')],
];

/**
 * GarageMenu: the builder's side panels. Left: the tube body and the parts to mount. Right: ride height,
 * paint, body panels, live stats and warnings, saved designs and the Test drive button.
 * It edits the Garage's Blueprint, asks the Garage to rebuild the preview, and hands the design to Game to drive.
 */
export class GarageMenu {
  root;
  garage;
  onTestDrive;
  bodyButtons = new Map();
  toolButtons = [];          // [{ node, part, modelKey }]
  paintSwatches = [];
  panelSelects = new Map();
  statCells = [];
  armedBody = null;
  armedAt = 0;
  nameInput;
  rideSlider;
  rideValue;
  mirrorBox;
  rotorsBox;
  warningList;
  hintLine;
  designSelect;
  importInput;

  constructor(parent, garage, onTestDrive) {
    this.garage = garage;
    this.onTestDrive = onTestDrive;
    this.root = element('div', 'garage-menu', parent);
    this.buildBuildPanel(element('div', 'garage-panel garage-left', this.root));
    this.buildDesignPanel(element('div', 'garage-panel garage-right', this.root));
    this.refresh();
  }

  show() { this.root.classList.remove('hidden'); this.refresh(); }
  hide() { this.root.classList.add('hidden'); }

  /** Shows what the pointer is doing in the garage, or the usual instructions. */
  setHint(text) {
    if (this.hintLine) this.hintLine.textContent = text ?? 'Pick a part, then click the frame. Drag to look around, scroll to zoom.';
  }

  /** Brings every control and stat up to date with the design; the Garage calls this after each edit. */
  refresh() {
    if (!this.warningList) return;
    const blueprint = this.garage.blueprint;
    const tool = this.garage.currentTool();
    for (const [key, node] of this.bodyButtons) {
      node.classList.toggle('selected', key === blueprint.bodyKey);
      node.classList.toggle('armed', key === this.armedBody);
    }
    for (const entry of this.toolButtons) {
      entry.node.classList.toggle('selected', tool?.part === entry.part && tool?.modelKey === entry.modelKey);
    }
    for (const swatch of this.paintSwatches) swatch.node.classList.toggle('selected', swatch.paint === blueprint.paint);
    for (const [slot, select] of this.panelSelects) select.value = blueprint.panels[slot];
    if (document.activeElement !== this.nameInput) this.nameInput.value = blueprint.name;
    this.rideSlider.value = blueprint.rideHeight;
    this.rideValue.textContent = `${blueprint.rideHeight.toFixed(2)} m`;
    this.mirrorBox.checked = this.garage.mirroring();
    this.rotorsBox.checked = this.garage.showingRotorsOut();

    const stats = blueprint.stats();
    this.statCells.forEach(([cell, format]) => { cell.textContent = format(stats); });
    const warnings = blueprint.warnings(stats);
    this.warningList.replaceChildren(...warnings.map(text => element('li', '', null, text)));
    this.warningList.classList.toggle('all-good', warnings.length === 0);
    if (warnings.length === 0) this.warningList.append(element('li', '', null, 'Ready to drive.'));
  }

  buildBuildPanel(panel) {
    element('div', 'garage-title', panel, 'Garage');
    element('div', 'garage-heading', panel, 'Tube body');
    const bodies = element('div', 'garage-choices', panel);
    for (const [key, body] of Object.entries(BODIES)) {
      const node = button('garage-choice', bodies, '', () => this.chooseBody(key));
      element('span', 'choice-name', node, body.name);
      element('span', 'choice-detail', node, body.blurb);
      this.bodyButtons.set(key, node);
    }

    for (const group of PART_GROUPS) {
      element('div', 'garage-heading', panel, group.title);
      const choices = element('div', 'garage-choices', panel);
      for (const [modelKey, model] of Object.entries(group.models)) {
        const node = button('garage-choice', choices, '', () => this.garage.selectTool(group.part, modelKey));
        node.title = model.blurb;
        element('span', 'choice-name', node, model.name);
        element('span', 'choice-detail', node, group.detail(model));
        this.toolButtons.push({ node, part: group.part, modelKey });
      }
    }

    const options = element('div', 'garage-options', panel);
    this.mirrorBox = checkbox(options, 'Mirror left and right (M)', checked => this.garage.setMirror(checked));
    this.rotorsBox = checkbox(options, 'Show rotors unfolded', checked => this.garage.setRotorsOut(checked));
    this.hintLine = element('div', 'garage-hint', panel);
    this.setHint(null);
  }

  buildDesignPanel(panel) {
    this.nameInput = element('input', 'garage-name', panel);
    this.nameInput.maxLength = 40;
    this.nameInput.addEventListener('change', () => this.edit(blueprint => blueprint.setName(this.nameInput.value), false));

    element('div', 'garage-heading', panel, 'Ride height');
    const ride = element('div', 'garage-ride', panel);
    this.rideSlider = element('input', '', ride);
    Object.assign(this.rideSlider, { type: 'range', min: RIDE_HEIGHT_RANGE.min, max: RIDE_HEIGHT_RANGE.max, step: 0.01 });
    this.rideSlider.addEventListener('input', () => this.edit(blueprint => blueprint.setRideHeight(Number(this.rideSlider.value))));
    this.rideValue = element('span', 'garage-ride-value', ride);
    element('div', 'garage-note', panel, 'Higher clears rocks and soaks up landings; lower corners flatter. The test rig can change it while driving (D-pad, or Z and X).');

    element('div', 'garage-heading', panel, 'Paint');
    const paints = element('div', 'garage-swatches', panel);
    for (const paint of PAINTS) {
      const node = button('garage-swatch', paints, '', () => this.edit(blueprint => blueprint.setPaint(paint)));
      node.style.background = paint;
      this.paintSwatches.push({ node, paint });
    }

    element('div', 'garage-heading', panel, 'Body panels');
    const panels = element('div', 'garage-panels', panel);
    for (const [slot, definition] of Object.entries(PANEL_SLOTS)) {
      element('label', '', panels, definition.name);
      const select = element('select', '', panels);
      for (const [styleKey, style] of Object.entries(definition.styles)) {
        const option = element('option', '', select, style.name);
        option.value = styleKey;
      }
      select.addEventListener('change', () => this.edit(blueprint => blueprint.setPanel(slot, select.value)));
      this.panelSelects.set(slot, select);
    }

    element('div', 'garage-heading', panel, 'How it adds up');
    const table = element('div', 'garage-stats', panel);
    for (const [label, format] of STAT_ROWS) {
      element('span', 'stat-label', table, label);
      this.statCells.push([element('span', 'stat-value', table), format]);
    }
    this.warningList = element('ul', 'garage-warnings', panel);

    element('div', 'garage-heading', panel, 'Designs');
    const designs = element('div', 'garage-designs', panel);
    this.designSelect = element('select', '', designs);
    button('', designs, 'Load', () => this.loadSelected());
    button('', designs, 'Save', () => this.saveCurrent());
    button('', designs, 'Delete', () => this.deleteSelected());
    const files = element('div', 'garage-designs', panel);
    button('', files, 'Export file', () => downloadText(`${this.garage.blueprint.name}.scrapwind.json`, JSON.stringify(this.garage.blueprint.toJSON(), null, 2)));
    button('', files, 'Import file', () => this.importInput.click());
    this.importInput = element('input', 'hidden', files);
    Object.assign(this.importInput, { type: 'file', accept: '.json,application/json' });
    this.importInput.addEventListener('change', () => this.importFile());
    this.fillDesignList();

    button('garage-drive', panel, 'Test drive  ▶', () => this.onTestDrive(this.garage.blueprint));
  }

  /** Applies an edit to the design and, unless it only changed a label, rebuilds the preview. */
  edit(change, rebuild = true) {
    change(this.garage.blueprint);
    if (rebuild) this.garage.rebuild();
    else this.refresh();
  }

  /** Switches body; if that would take parts off, the first click arms it and a second confirms. */
  chooseBody(key) {
    const blueprint = this.garage.blueprint;
    if (key === blueprint.bodyKey) return;
    const armed = this.armedBody === key && performance.now() - this.armedAt < ARM_SECONDS * 1000;
    if (blueprint.mounts.length > 0 && !armed) {
      this.armedBody = key;
      this.armedAt = performance.now();
      this.setHint(`Click ${BODIES[key].name} again to switch. Its frame is different, so the parts come off.`);
      this.refresh();
      return;
    }
    this.armedBody = null;
    this.garage.clearTool();
    this.edit(design => design.setBody(key));
    this.setHint(null);
  }

  fillDesignList() {
    const options = [
      ...Object.entries(PRESETS).map(([key, preset]) => ({ value: `preset:${key}`, label: `Starter: ${preset.name}` })),
      ...Object.keys(savedDesigns()).map(name => ({ value: `saved:${name}`, label: name })),
    ];
    this.designSelect.replaceChildren(...options.map(({ value, label }) => {
      const option = element('option', '', null, label);
      option.value = value;
      return option;
    }));
  }

  loadSelected() {
    const [kind, key] = splitOnce(this.designSelect.value, ':');
    const json = kind === 'preset' ? PRESETS[key] : savedDesigns()[key];
    if (json) this.garage.setBlueprint(Blueprint.fromJSON(json));
  }

  saveCurrent() {
    const designs = savedDesigns();
    const blueprint = this.garage.blueprint;
    designs[blueprint.name] = blueprint.toJSON();
    storeDesigns(designs);
    this.fillDesignList();
    this.designSelect.value = `saved:${blueprint.name}`;
    this.setHint(`Saved "${blueprint.name}".`);
  }

  deleteSelected() {
    const [kind, key] = splitOnce(this.designSelect.value, ':');
    if (kind !== 'saved') {
      this.setHint('Starter designs stay; only your own saves can be deleted.');
      return;
    }
    const designs = savedDesigns();
    delete designs[key];
    storeDesigns(designs);
    this.fillDesignList();
    this.setHint(`Deleted "${key}".`);
  }

  async importFile() {
    const file = this.importInput.files[0];
    this.importInput.value = '';
    if (!file) return;
    try {
      this.garage.setBlueprint(Blueprint.fromJSON(await file.text()));
      this.setHint(`Imported "${this.garage.blueprint.name}".`);
    } catch {
      this.setHint("That file isn't a design this garage can read.");
    }
  }
}

function checkbox(parent, label, onChange) {
  const row = element('label', 'garage-check', parent);
  const box = element('input', '', row);
  box.type = 'checkbox';
  element('span', '', row, label);
  box.addEventListener('change', () => onChange(box.checked));
  return box;
}

function savedDesigns() {
  try {
    return JSON.parse(localStorage.getItem(SAVED_DESIGNS_KEY)) ?? {};
  } catch {
    return {};
  }
}

function storeDesigns(designs) {
  try {
    localStorage.setItem(SAVED_DESIGNS_KEY, JSON.stringify(designs));
  } catch {
    // Storage can be full or blocked; saving to a file still works.
  }
}

function splitOnce(text, separator) {
  const index = text.indexOf(separator);
  return [text.slice(0, index), text.slice(index + 1)];
}

function kilowatts(watts) {
  return Math.round(watts / 1000);
}
