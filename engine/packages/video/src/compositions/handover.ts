/*
 * The change between a title card and the app window. The two never show at once (a
 * cross-fade looks like a double exposure): during the transition the outgoing picture
 * leaves in the first part, and the incoming one arrives in the rest.
 */

/** Share of the transition the outgoing picture takes to leave. */
export const HANDOVER_SPLIT = 0.5;

const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** 0 → 1 as the incoming picture arrives, over the transition starting at 0 ms. */
export function handoverIn(ms: number, transitionMs: number): number {
  const from = transitionMs * HANDOVER_SPLIT * 0.8;
  return ease((ms - from) / Math.max(1, transitionMs - from));
}

/** 0 → 1 as the outgoing picture leaves, over the transition that ends at `endMs`. */
export function handoverOut(ms: number, endMs: number, transitionMs: number): number {
  const from = endMs - transitionMs;
  return ease((ms - from) / Math.max(1, transitionMs * HANDOVER_SPLIT));
}
