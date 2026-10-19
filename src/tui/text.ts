/** Terminal text: display widths (CJK is two cells), truncation, padding and styles. */

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

export function width(text: string): number {
  return Bun.stringWidth(text);
}

/** Cuts plain text to at most `max` cells, with an ellipsis when cut. */
export function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  if (width(text) <= max) return text;
  let out = "";
  let used = 0;
  for (const g of graphemes(text)) {
    const w = width(g);
    if (used + w > max - 1) break;
    out += g;
    used += w;
  }
  return out + "…";
}

/** Pads plain or styled text with spaces to `cells` cells (cuts plain text that is longer). */
export function pad(text: string, cells: number): string {
  const w = width(text);
  if (w > cells) return truncate(text, cells);
  return text + " ".repeat(cells - w);
}

export function padStart(text: string, cells: number): string {
  const w = width(text);
  return w >= cells ? text : " ".repeat(cells - w) + text;
}

/** Splits text into rows of at most `cells` cells, breaking anywhere (CJK has no spaces). */
export function wrap(text: string, cells: number): string[] {
  const rows: string[] = [];
  for (const line of text.split("\n")) {
    let row = "";
    let used = 0;
    for (const g of graphemes(line)) {
      const w = width(g);
      if (used + w > cells && row !== "") {
        rows.push(row);
        row = "";
        used = 0;
      }
      row += g;
      used += w;
    }
    rows.push(row);
  }
  return rows;
}

/** Removes control characters a pane's output may carry, so it cannot move our cursor. */
export function sanitize(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

/**
 * Like sanitize, but keeps SGR (`ESC [ … m`: colors and text styles) for a page to draw. Every
 * other sequence goes: OSC (titles, hyperlinks), cursor and mode changes, charset switches.
 */
export function sanitizeKeepStyle(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[([0-9;:?<=>]*)([ -/]*)([@-~])/g, (all, params: string, inter: string, final: string) => (final === "m" && !inter && !/[?<=>]/.test(params) ? all : ""))
    .replace(/\x1b[()*+#%][0-9A-Za-z@]?/g, "")
    .replace(/\x1b[0-9A-Za-z=>\\]/g, "")
    .replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g, "")
    // an ESC left on its own is not the start of a style any more
    .replace(/\x1b(?!\[)/g, "");
}

const sgr = (on: string, off: string) => (text: string) => `\x1b[${on}m${text}\x1b[${off}m`;

export const style = {
  bold: sgr("1", "22"),
  dim: sgr("2", "22"),
  italic: sgr("3", "23"),
  underline: sgr("4", "24"),
  inverse: sgr("7", "27"),
  red: sgr("31", "39"),
  green: sgr("32", "39"),
  yellow: sgr("33", "39"),
  blue: sgr("34", "39"),
  magenta: sgr("35", "39"),
  cyan: sgr("36", "39"),
  gray: sgr("90", "39"),
};

/** An OSC 8 hyperlink: clickable in terminals that support it, plain text elsewhere. */
export function hyperlink(url: string, text: string = url): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

export function relativeTime(at: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}秒前`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}分钟前`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}小时前`;
  return `${Math.round(h / 24)}天前`;
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}
