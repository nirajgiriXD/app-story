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
  const own = p.brand.background;
  // An image is dimmed (see backdrop), so the words on it are light.
  if (own?.image) return true;
  if (own?.color) return luminance(own.color) < 0.45;
  return p.template.backdrop === "dark";
}

/** Relative luminance of a #RRGGBB colour, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

export function backdrop(p: RenderProps): string {
  const own = p.brand.background;
  // The brand's image, dimmed a little so the title and the window stand out on it.
  if (own?.image) return `linear-gradient(rgba(2, 6, 23, 0.38), rgba(2, 6, 23, 0.38)), url("${asset(p, own.image)}") center / cover no-repeat`;
  if (own?.color) return `radial-gradient(circle at 15% 10%, ${p.brand.primary}40, transparent 55%), ${own.color}`;
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

/** Scale design pixels (authored for a 1080-pixel short side) to the output's short side. */
export function px(p: RenderProps, value: number): number {
  return (value * Math.min(p.width, p.height)) / 1080;
}

/** The frame's shape: landscape (16:9), portrait (9:16, for Reels and Shorts) or square. */
export function shape(p: Pick<RenderProps, "width" | "height">): "wide" | "tall" | "square" {
  return p.width > p.height * 1.2 ? "wide" : p.height > p.width * 1.2 ? "tall" : "square";
}
