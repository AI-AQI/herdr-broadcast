/**
 * A filterable picker in the manner of herdr-plus's Quick Actions: type to filter, ↑↓ to move,
 * Enter to run, Esc to clear the filter, then to go back. Items sit under section headings; a
 * filter collapses them into one list ranked by match.
 */
import { type App, type Screen } from "../app.ts";
import { TextInput } from "../input.ts";
import type { Key } from "../keys.ts";
import type { Line } from "../term.ts";
import { pad, style, truncate, width } from "../text.ts";

export interface PickerItem {
  section: string;
  /** what the filter matches first */
  label: string;
  /** dimmed after the label; matched too */
  detail?: string;
  /** shown under the list while the item is selected */
  note?: string;
  disabled?: boolean;
  run: () => void | Promise<void>;
  /** Ctrl+letter shortcuts on this item, by letter ("o" for Ctrl+O): typing is the filter's */
  actions?: Record<string, () => void | Promise<void>>;
}

/** Subsequence match: every typed character in order. Lower is better; null is no match. */
export function matchScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (q === "") return 0;
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return direct;
  let at = -1;
  let gaps = 0;
  for (const ch of q) {
    const next = t.indexOf(ch, at + 1);
    if (next < 0) return null;
    gaps += next - at - 1;
    at = next;
  }
  return 1_000 + gaps;
}

export abstract class PickerScreen implements Screen {
  protected filter = new TextInput("", "输入以过滤…");
  private index = 0;
  private offset = 0;
  private shown: PickerItem[] = [];

  constructor(protected readonly app: App) {}

  abstract title(): string;
  protected abstract items(): PickerItem[];
  /** what Esc does with an empty filter */
  protected back(): void {
    this.app.pop();
  }

  hints(): string {
    return "↑↓ 移动 · Enter 执行 · 输入过滤 · Esc 返回";
  }

  private visible(): PickerItem[] {
    const all = this.items();
    const query = this.filter.value.trim();
    if (!query) return all;
    return all
      .map((item, order) => ({ item, order, score: matchScore(query, `${item.label} ${item.detail ?? ""}`) }))
      .filter((m): m is { item: PickerItem; order: number; score: number } => m.score !== null)
      .sort((a, b) => a.score - b.score || a.order - b.order)
      .map((m) => m.item);
  }

  render(cols: number, rows: number): Line[] {
    this.shown = this.visible();
    this.index = Math.max(0, Math.min(this.index, this.shown.length - 1));
    const out: Line[] = [];
    out.push(` ${style.magenta("❯")} ${this.filter.render(Math.max(10, cols - 16), true)}  ${style.dim(`${this.shown.length}/${this.items().length}`)}`);
    out.push("");

    const grouped = this.filter.value.trim() === "";
    const lines: { text: string; item: number | null }[] = [];
    let section: string | null = null;
    this.shown.forEach((item, i) => {
      if (grouped && item.section !== section) {
        if (section !== null) lines.push({ text: "", item: null });
        section = item.section;
        lines.push({ text: ` ${style.bold(style.magenta(item.section))}`, item: null });
      }
      const selected = i === this.index;
      const labelW = Math.min(Math.max(...this.shown.map((s) => width(s.label))), Math.floor(cols * 0.55));
      const label = pad(truncate(item.label, labelW), labelW);
      const detail = item.detail ? `  ${style.dim(truncate(item.detail, Math.max(0, cols - labelW - 8)))}` : "";
      const body = item.disabled ? style.gray(`${label}${item.detail ? `  ${truncate(item.detail, Math.max(0, cols - labelW - 8))}` : ""}`) : `${selected ? style.bold(label) : label}${detail}`;
      lines.push({ text: `${selected ? style.magenta(" ▌") : "  "} ${body}`, item: i });
    });
    if (this.shown.length === 0) lines.push({ text: style.dim("   没有匹配的条目"), item: null });

    const note = this.shown[this.index]?.note;
    const room = Math.max(3, rows - out.length - (note ? 2 : 0));
    const selectedLine = Math.max(0, lines.findIndex((l) => l.item === this.index));
    if (selectedLine < this.offset) this.offset = Math.max(0, selectedLine - 1);
    if (selectedLine >= this.offset + room) this.offset = selectedLine - room + 1;
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, lines.length - room)));
    out.push(...lines.slice(this.offset, this.offset + room).map((l) => l.text));
    if (note) {
      while (out.length < rows - 2) out.push("");
      out.push("");
      out.push(` ${style.yellow(truncate(note, cols - 2))}`);
    }
    return out;
  }

  async key(key: Key): Promise<void> {
    if (key.name === "escape") {
      if (this.filter.value !== "") this.filter.value = "";
      else this.back();
      return;
    }
    if (key.name === "up") this.index = Math.max(0, this.index - 1);
    else if (key.name === "down") this.index = Math.min(this.shown.length - 1, this.index + 1);
    else if (key.name === "pageup") this.index = Math.max(0, this.index - 10);
    else if (key.name === "pagedown") this.index = Math.min(this.shown.length - 1, this.index + 10);
    else if (key.name === "enter") {
      const item = this.shown[this.index];
      if (item && !item.disabled) await item.run();
      else if (item?.note) this.app.say(item.note, true);
    } else if (key.ctrl && this.shown[this.index]?.actions?.[key.name]) await this.shown[this.index]!.actions![key.name]!();
    else if (this.filter.key(key)) this.index = 0;
  }
}
