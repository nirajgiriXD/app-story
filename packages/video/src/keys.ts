/*
 * Key presses as the viewer sees them: "Control+Shift+K" becomes the keycaps Ctrl, Shift, K.
 * Pure, shared by the Node side and the render page.
 */

const NAMES: Record<string, string> = {
  control: "Ctrl",
  controlormeta: "Ctrl",
  meta: "⌘",
  alt: "Alt",
  shift: "Shift",
  enter: "Enter",
  escape: "Esc",
  backspace: "Backspace",
  delete: "Del",
  tab: "Tab",
  space: "Space",
  " ": "Space",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  pageup: "Page Up",
  pagedown: "Page Down",
  home: "Home",
  end: "End",
};

/** The keycaps of a Playwright key name such as `Control+K`, `Enter` or `Shift+ArrowDown`. */
export function keyLabels(key: string): string[] {
  // "+" alone (or at the end, as in "Control++") is the plus key itself.
  const parts = key.trim().split(/\+(?=.)/);
  return parts
    .map((part) => (part === "" ? "+" : part))
    .map((part) => NAMES[part.toLowerCase()] ?? (part.length === 1 ? part.toUpperCase() : part.replace(/^Key([A-Z])$/, "$1").replace(/^Digit(\d)$/, "$1")));
}
