/** Screens on a stack, one frame per change, a status line, and modal confirms. */
import type { Engine } from "../engine.ts";
import type { Store } from "../db.ts";
import type { Key } from "./keys.ts";
import { Terminal, type Line } from "./term.ts";
import { pad, style, truncate, width } from "./text.ts";

export interface Screen {
  title(): string;
  /** the body: `rows` rows at most, `cols` wide */
  render(cols: number, rows: number): Line[];
  /** key hints for the footer */
  hints(): string;
  key(key: Key): void | Promise<void>;
  enter?(): void;
  leave?(): void;
}

interface Confirm {
  message: string;
  yes: () => void | Promise<void>;
}

export class App {
  readonly term = new Terminal();
  private stack: Screen[] = [];
  private status: { text: string; error: boolean; at: number } | null = null;
  private confirmation: Confirm | null = null;
  private pending = false;
  private quitting: (() => void) | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  /** the "📡 Herdr Broadcast ›" prefix in the title bar; the popup picker goes without */
  brand = true;

  constructor(readonly store: Store, readonly engine: Engine) {}

  run(first: Screen): Promise<void> {
    return new Promise((resolve) => {
      this.quitting = resolve;
      this.term.start((key) => void this.onKey(key), () => this.redraw());
      this.push(first);
      // relative times and spinners move without input
      this.ticker = setInterval(() => this.redraw(), 1_000);
    });
  }

  quit(): void {
    if (this.ticker) clearInterval(this.ticker);
    for (const screen of this.stack) screen.leave?.();
    this.term.stop();
    this.quitting?.();
  }

  get top(): Screen | undefined {
    return this.stack[this.stack.length - 1];
  }

  push(screen: Screen): void {
    this.stack.push(screen);
    screen.enter?.();
    this.redraw();
  }

  pop(): void {
    if (this.stack.length <= 1) {
      this.quit();
      return;
    }
    this.stack.pop()?.leave?.();
    this.redraw();
  }

  /** Replaces the screens above the first with `screen`. */
  resetTo(screen: Screen): void {
    while (this.stack.length > 1) this.stack.pop()?.leave?.();
    this.push(screen);
  }

  /** Back to the first screen. */
  popToRoot(): void {
    while (this.stack.length > 1) this.stack.pop()?.leave?.();
    this.redraw();
  }

  /** Set by the broadcast list: opens and selects a broadcast. */
  showBroadcast: ((id: number) => void) | null = null;

  say(text: string, error = false): void {
    this.status = { text, error, at: Date.now() };
    this.redraw();
  }

  fail(error: unknown): void {
    this.say(error instanceof Error ? error.message : String(error), true);
  }

  confirm(message: string, yes: () => void | Promise<void>): void {
    this.confirmation = { message, yes };
    this.redraw();
  }

  /** Coalesces redraws: many changes in one turn draw one frame. */
  redraw(): void {
    if (this.pending) return;
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      this.draw();
    });
  }

  private draw(): void {
    const screen = this.top;
    if (!screen) return;
    const cols = this.term.cols;
    const rows = this.term.rows;
    const title = this.brand ? ` 📡 Herdr Broadcast  ${style.dim("›")} ${screen.title()}` : ` ${screen.title()}`;
    const header = style.inverse(pad(title, cols));
    const bodyRows = Math.max(1, rows - 3);
    const body = screen.render(cols, bodyRows).slice(0, bodyRows);
    while (body.length < bodyRows) body.push("");
    let statusLine = "";
    if (this.confirmation) statusLine = style.yellow(`${this.confirmation.message}  [y] 确认  [n] 取消`);
    else if (this.status && Date.now() - this.status.at < 8_000) statusLine = this.status.error ? style.red(truncate(this.status.text, cols)) : style.green(truncate(this.status.text, cols));
    const footer = style.dim(truncate(screen.hints(), cols));
    // a wrapping line takes extra rows: make room by dropping body rows from the end
    let extra = 0;
    for (const line of body) if (typeof line !== "string") extra += Math.max(1, Math.ceil(width(line.text) / cols)) - 1;
    const trimmed = extra > 0 ? body.slice(0, Math.max(0, body.length - extra)) : body;
    this.term.draw([header, ...trimmed, statusLine, footer]);
  }

  private async onKey(key: Key): Promise<void> {
    if (this.confirmation) {
      const pending = this.confirmation;
      if (key.name === "char" && (key.text === "y" || key.text === "Y")) {
        this.confirmation = null;
        try {
          await pending.yes();
        } catch (error) {
          this.fail(error);
        }
      } else if (key.name === "escape" || (key.name === "char" && (key.text === "n" || key.text === "N"))) {
        this.confirmation = null;
      }
      this.redraw();
      return;
    }
    if (key.name === "c" && key.ctrl) {
      this.quit();
      return;
    }
    try {
      await this.top?.key(key);
    } catch (error) {
      this.fail(error);
    }
    this.redraw();
  }
}

/** Keeps a selection inside a list and scrolls a window over it. */
export class ListCursor {
  index = 0;
  private offset = 0;

  move(delta: number, length: number): void {
    if (length === 0) {
      this.index = 0;
      return;
    }
    this.index = Math.max(0, Math.min(length - 1, this.index + delta));
  }

  clamp(length: number): void {
    this.index = Math.max(0, Math.min(this.index, length - 1));
  }

  /** The [start, end) slice of a list of `length` items shown in `rows` rows. */
  window(length: number, rows: number): [number, number] {
    this.clamp(length);
    if (this.index < this.offset) this.offset = this.index;
    if (this.index >= this.offset + rows) this.offset = this.index - rows + 1;
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, length - rows)));
    return [this.offset, Math.min(length, this.offset + rows)];
  }

  /** Arrow keys, j/k, page keys; returns true when it moved. */
  key(key: Key, length: number, page = 10): boolean {
    if (key.name === "up" || (key.name === "char" && key.text === "k")) this.move(-1, length);
    else if (key.name === "down" || (key.name === "char" && key.text === "j")) this.move(1, length);
    else if (key.name === "pageup") this.move(-page, length);
    else if (key.name === "pagedown") this.move(page, length);
    else if (key.name === "home") this.index = 0;
    else if (key.name === "end") this.index = Math.max(0, length - 1);
    else return false;
    return true;
  }
}

export function isChar(key: Key, ...chars: string[]): boolean {
  return key.name === "char" && !key.alt && chars.includes(key.text ?? "");
}
