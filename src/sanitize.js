// Text that comes from agents or from a Flagsmith server is data. Before it reaches a terminal,
// neutralise control characters so escape sequences can't redraw, hide or fake what a person sees
// (cursor moves, erase-line, OSC 52 clipboard writes, GitHub `::workflow-commands::` via newlines).

// C0 controls (incl. ESC, CR, LF, TAB), DEL and C1 controls.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

// For one-line display: every control character becomes a visible escape like \x1b.
export function clean(value) {
  if (value == null) return value;
  return String(value).replace(CONTROL, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

// True when a string contains any control character (used to reject agent input outright).
export const hasControl = (s) => typeof s === 'string' && /[\u0000-\u001f\u007f-\u009f]/.test(s);
