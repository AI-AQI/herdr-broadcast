/** Editable text fields: one line (TextInput) and many (TextArea). Both edit by grapheme. */
import type { Key } from "./keys.ts";
import { graphemes, style, width } from "./text.ts";

const CURSOR = (g: string) => style.inverse(g === "" ? " " : g);

export class TextInput {
  private chars: string[];
  private cursor: number;

  constructor(value = "", readonly placeholder = "") {
    this.chars = graphemes(value);
    this.cursor = this.chars.length;
  }

  get value(): string {
    return this.chars.join("");
  }

  set value(text: string) {
    this.chars = graphemes(text);
    this.cursor = this.chars.length;
  }

  /** Returns true when the key edited the field. */
  key(key: Key): boolean {
    switch (key.name) {
      case "char":
      case "paste": {
        const text = (key.text ?? "").replace(/\n/g, " ");
        const add = graphemes(text);
        this.chars.splice(this.cursor, 0, ...add);
        this.cursor += add.length;
        return true;
      }
      case "backspace":
        if (this.cursor > 0) this.chars.splice(--this.cursor, 1);
        return true;
      case "delete":
        this.chars.splice(this.cursor, 1);
        return true;
      case "left":
        this.cursor = Math.max(0, this.cursor - 1);
        return true;
      case "right":
        this.cursor = Math.min(this.chars.length, this.cursor + 1);
        return true;
      case "home":
      case "a":
        if (key.name === "a" && !key.ctrl) return false;
        this.cursor = 0;
        return true;
      case "end":
      case "e":
        if (key.name === "e" && !key.ctrl) return false;
        this.cursor = this.chars.length;
        return true;
      case "u":
        if (!key.ctrl) return false;
        this.chars.splice(0, this.cursor);
        this.cursor = 0;
        return true;
      default:
        return false;
    }
  }

  /** One row of `cells` cells, scrolled so the cursor shows. */
  render(cells: number, focused: boolean): string {
    if (this.chars.length === 0 && !focused) return style.gray(this.placeholder);
    if (this.chars.length === 0 && focused) return CURSOR(" ") + style.gray(this.placeholder);
    // scroll: keep the cursor inside the window
    let start = 0;
    let used = 0;
    for (let i = this.cursor; i > 0; i -= 1) {
      used += width(this.chars[i - 1]!);
      if (used > cells - 2) {
        start = i;
        break;
      }
    }
    let out = "";
    let cellsUsed = 0;
    for (let i = start; i <= this.chars.length; i += 1) {
      const g = this.chars[i] ?? "";
      const w = Math.max(1, width(g));
      if (cellsUsed + w > cells) break;
      out += focused && i === this.cursor ? CURSOR(g) : g;
      cellsUsed += w;
      if (i === this.chars.length) break;
    }
    return out;
  }
}

export class TextArea {
  private lines: string[][];
  private row = 0;
  private col = 0;
  /** the first visual row shown */
  private scroll = 0;

  constructor(value = "") {
    this.lines = value.split("\n").map(graphemes);
    this.row = this.lines.length - 1;
    this.col = this.lines[this.row]!.length;
  }

  get value(): string {
    return this.lines.map((l) => l.join("")).join("\n");
  }

  set value(text: string) {
    this.lines = text.split("\n").map(graphemes);
    this.row = this.lines.length - 1;
    this.col = this.lines[this.row]!.length;
  }

  private insert(text: string): void {
    const parts = text.split("\n");
    const line = this.lines[this.row]!;
    const tail = line.splice(this.col);
    const first = graphemes(parts[0]!);
    line.push(...first);
    this.col += first.length;
    for (const part of parts.slice(1)) {
      const next = graphemes(part);
      this.lines.splice(++this.row, 0, next);
      this.col = next.length;
    }
    this.lines[this.row]!.push(...tail);
  }

  key(key: Key): boolean {
    const line = this.lines[this.row]!;
    switch (key.name) {
      case "char":
        this.insert(key.text ?? "");
        return true;
      case "paste":
        this.insert((key.text ?? "").replace(/\t/g, "  "));
        return true;
      case "enter":
      case "newline":
        this.insert("\n");
        return true;
      case "backspace":
        if (this.col > 0) line.splice(--this.col, 1);
        else if (this.row > 0) {
          const prev = this.lines[this.row - 1]!;
          this.col = prev.length;
          prev.push(...line);
          this.lines.splice(this.row, 1);
          this.row -= 1;
        }
        return true;
      case "delete":
        if (this.col < line.length) line.splice(this.col, 1);
        else if (this.row < this.lines.length - 1) {
          line.push(...this.lines[this.row + 1]!);
          this.lines.splice(this.row + 1, 1);
        }
        return true;
      case "left":
        if (this.col > 0) this.col -= 1;
        else if (this.row > 0) this.col = this.lines[--this.row]!.length;
        return true;
      case "right":
        if (this.col < line.length) this.col += 1;
        else if (this.row < this.lines.length - 1) {
          this.row += 1;
          this.col = 0;
        }
        return true;
      case "up":
        if (this.row > 0) this.col = Math.min(this.col, this.lines[--this.row]!.length);
        return true;
      case "down":
        if (this.row < this.lines.length - 1) this.col = Math.min(this.col, this.lines[++this.row]!.length);
        return true;
      case "home":
        this.col = 0;
        return true;
      case "end":
        this.col = line.length;
        return true;
      default:
        return false;
    }
  }

  /** `height` rows of `cells` cells, wrapped, scrolled to the cursor. */
  render(cells: number, height: number, focused: boolean): string[] {
    const rows: string[] = [];
    let cursorRow = 0;
    this.lines.forEach((line, li) => {
      let row = "";
      let used = 0;
      for (let ci = 0; ci <= line.length; ci += 1) {
        const g = line[ci] ?? "";
        const w = Math.max(1, width(g));
        const atCursor = focused && li === this.row && ci === this.col;
        if (ci === line.length && !atCursor) break;
        if (used + w > cells && used > 0) {
          rows.push(row);
          row = "";
          used = 0;
        }
        if (atCursor) cursorRow = rows.length;
        row += atCursor ? CURSOR(g) : g;
        used += w;
      }
      rows.push(row);
    });
    if (cursorRow < this.scroll) this.scroll = cursorRow;
    if (cursorRow >= this.scroll + height) this.scroll = cursorRow - height + 1;
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, rows.length - height)));
    const shown = rows.slice(this.scroll, this.scroll + height);
    while (shown.length < height) shown.push("");
    return shown;
  }
}
