import { element } from './dom.js';

const SHOW_SECONDS = 4.5;
const MAX_SHOWN = 3;

/**
 * Toast: short messages that slide in at the top of the screen and fade away, in the garage or on the
 * track alike: controllers connecting, room news. Game owns one; anything with news hands it a sentence.
 */
export class Toast {
  root;

  constructor(parent) {
    this.root = element('div', 'toasts', parent);
  }

  /** Shows a sentence for a few seconds; the oldest goes first if too many pile up. */
  show(text) {
    const note = element('div', 'toast', this.root, text);
    while (this.root.children.length > MAX_SHOWN) this.root.firstChild.remove();
    setTimeout(() => note.classList.add('leaving'), SHOW_SECONDS * 1000);
    setTimeout(() => note.remove(), SHOW_SECONDS * 1000 + 600);
  }
}
