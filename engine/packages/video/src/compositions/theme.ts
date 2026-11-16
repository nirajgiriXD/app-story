import type { RenderProps } from "../props";

/** URL of a job file (for example the logo) as the render page loads it. */
export function asset(_p: RenderProps, src: string): string {
  return `/files/${src.split("/").map(encodeURIComponent).join("/")}`;
}

/** URL of the recording's frame `index` (0 = recording start), streamed to the page by the renderer. */
export function recordingFrame(index: number): string {
  return `/recording/${Math.max(0, Math.round(index))}.jpg`;
}

export function fontStack(font: string): string {
  return `"${font}", Inter, "Segoe UI", Roboto, "Helvetica Neue", Arial, system-ui, sans-serif`;
}

export function isDark(p: RenderProps): boolean {
  return p.template.backdrop === "dark";
}

export function backdrop(p: RenderProps): string {
  const { primary, accent } = p.brand;
  switch (p.template.backdrop) {
    case "dark":
      return `radial-gradient(circle at 15% 10%, ${primary}55, transparent 55%), linear-gradient(135deg, ${accent}, #020617)`;
    case "light":
      return "#F8FAFC";
    default:
      return `radial-gradient(circle at 12% 15%, ${primary}30, transparent 55%), radial-gradient(circle at 88% 90%, ${primary}24, transparent 50%), linear-gradient(135deg, #F8FAFC, #EEF2FF)`;
  }
}

export function textColor(p: RenderProps): { strong: string; muted: string } {
  return isDark(p) ? { strong: "#F8FAFC", muted: "#CBD5E1" } : { strong: p.brand.accent, muted: "#475569" };
}

/** Scale design pixels (authored at 1080p) to the output height. */
export function px(p: RenderProps, value: number): number {
  return (value * p.height) / 1080;
}
