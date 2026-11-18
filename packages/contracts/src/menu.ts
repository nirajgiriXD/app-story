/*
 * The geometry of a drawn dropdown list. Plain maths with no schema library, so the render
 * page can import it (`@app-story/contracts/menu`) without bundling Zod.
 */

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The most options a drawn dropdown list shows at once. */
const MENU_ROWS = 8;

/**
 * Where a dropdown's list is drawn (viewport CSS pixels): under the field, or above it when
 * there is no room below, with a window of rows that contains the chosen option. Shared by
 * the recorder (to move the pointer onto the option) and the video (to draw the list).
 */
export function menuLayout(
  field: Rect,
  menu: { options: readonly string[]; to: number },
  viewport: { width: number; height: number },
): { x: number; y: number; width: number; rowHeight: number; first: number; rows: number } {
  const rowHeight = Math.max(24, Math.min(40, field.height));
  const rows = Math.max(1, Math.min(MENU_ROWS, menu.options.length));
  const first = Math.max(0, Math.min(menu.to - Math.floor(rows / 2), menu.options.length - rows));
  const height = rows * rowHeight + 8;
  const below = field.y + field.height + 4;
  const y = below + height <= viewport.height || field.y - 4 - height < 0 ? below : field.y - 4 - height;
  return { x: field.x, y, width: Math.max(field.width, 160), rowHeight, first, rows };
}
