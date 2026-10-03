import GUI from 'lil-gui';

const SLIDER_RANGE_MULTIPLE = 3; // sliders run from 0 to three times the starting value

/**
 * TuningPanel: live sliders over every physics tuning record, for dialling in the feel.
 * Deliberate exception to "data stays inside its class": lil-gui binds straight to object properties,
 * so the panel edits the tuning records in place, and each class reads its record every step.
 * Game builds it with the list of records and toggles it from Controls.
 */
export class TuningPanel {
  gui;
  sections;   // [{ title, record, onChange? }]
  defaults;   // a copy of each record as it started
  visible = false;

  constructor(sections) {
    this.sections = sections;
    this.defaults = sections.map(section => ({ ...section.record }));
    this.gui = new GUI({ title: 'Tuning  (G / Start to hide)' });

    for (const section of sections) {
      const folder = this.gui.addFolder(section.title);
      for (const [key, value] of Object.entries(section.record)) {
        const controller = folder.add(section.record, key, ...sliderRange(value)).name(words(key));
        if (section.onChange) controller.onChange(section.onChange);
      }
      folder.close();
    }
    this.gui.add({ copy: () => this.copyValues() }, 'copy').name('Copy values as JSON');
    this.gui.add({ reset: () => this.resetValues() }, 'reset').name('Reset to defaults');
    this.gui.hide();
  }

  toggle() {
    this.visible = !this.visible;
    this.gui.show(this.visible);
  }

  /** Puts the current values on the clipboard, so good settings can be pasted back into the code. */
  copyValues() {
    const values = Object.fromEntries(this.sections.map(section => [section.title, section.record]));
    const text = JSON.stringify(values, null, 2);
    navigator.clipboard?.writeText(text).catch(() => {});
    console.log(text);
  }

  resetValues() {
    this.sections.forEach((section, index) => {
      Object.assign(section.record, this.defaults[index]);
      section.onChange?.();
    });
    for (const controller of this.gui.controllersRecursive()) controller.updateDisplay();
  }
}

function sliderRange(value) {
  if (value === 0) return [0, 1, 0.01];
  const max = value * SLIDER_RANGE_MULTIPLE;
  const step = 10 ** (Math.floor(Math.log10(max)) - 2);
  return [0, max, step];
}

/** "springStiffness" → "spring stiffness" */
function words(key) {
  return key.replace(/([A-Z])/g, ' $1').toLowerCase();
}
