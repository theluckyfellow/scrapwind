// Small DOM helpers shared by the on-screen panels (Telemetry, GarageMenu).

/** Makes an element, gives it a class and text, and appends it to a parent. */
export function element(tag, className, parent, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (parent) parent.appendChild(node);
  return node;
}

/** A button that runs `action` when clicked. */
export function button(className, parent, text, action) {
  const node = element('button', className, parent, text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

/** Offers some text to the viewer as a file download. */
export function downloadText(filename, text) {
  const link = element('a', '', null);
  link.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}
