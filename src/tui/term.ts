/** The full-screen terminal: alternate screen, raw input, whole-frame redraws, and suspending for child programs. */
import { KeyParser, type Key } from "./keys.ts";
import { truncate, width } from "./text.ts";

/** A frame line. `wrap` lines (long URLs) may take several rows so terminals can still detect them. */
export type Line = string | { text: string; wrap: true };

const ENTER = "\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[H\x1b[2J";
const LEAVE = "\x1b[?2004l\x1b[?25h\x1b[?1049l";

export class Terminal {
  private parser = new KeyParser();
  private onData = (chunk: Buffer | string) => {
    for (const key of this.parser.feed(chunk.toString())) this.keyHandler?.(key);
  };
  private onResizeEvent = () => this.resizeHandler?.();
  private keyHandler: ((key: Key) => void) | null = null;
  private resizeHandler: (() => void) | null = null;
  private active = false;

  get cols(): number {
    return process.stdout.columns || 80;
  }

  get rows(): number {
    return process.stdout.rows || 24;
  }

  start(onKey: (key: Key) => void, onResize: () => void): void {
    this.keyHandler = onKey;
    this.resizeHandler = onResize;
    this.attach();
    process.stdout.on("resize", this.onResizeEvent);
  }

  private attach(): void {
    if (this.active) return;
    this.active = true;
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", this.onData);
    process.stdin.resume();
    process.stdout.write(ENTER);
  }

  private detach(): void {
    if (!this.active) return;
    this.active = false;
    process.stdin.off("data", this.onData);
    process.stdin.pause();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write(LEAVE);
  }

  stop(): void {
    this.detach();
    process.stdout.off("resize", this.onResizeEvent);
  }

  /** Draws a whole frame. Lines past the screen are dropped; long lines are cut unless `wrap`. */
  draw(lines: Line[]): void {
    if (!this.active) return;
    const cols = this.cols;
    const rows = this.rows;
    let out = "\x1b[H";
    let used = 0;
    for (const line of lines) {
      if (typeof line === "string") {
        if (used + 1 > rows) break;
        out += (width(line) > cols ? truncate(stripForCut(line), cols) : line) + "\x1b[0m\x1b[K";
        used += 1;
      } else {
        const need = Math.max(1, Math.ceil(width(line.text) / cols));
        if (used + need > rows) break;
        out += line.text + "\x1b[0m\x1b[K";
        used += need;
      }
      if (used < rows) out += "\r\n";
    }
    out += "\x1b[J";
    process.stdout.write(out);
  }

  /** Leaves the screen, runs an interactive program on the real terminal, and comes back. */
  async suspend<T>(run: () => Promise<T>): Promise<T> {
    this.detach();
    process.stdout.write("\x1b[H\x1b[2J");
    try {
      return await run();
    } finally {
      this.attach();
      this.resizeHandler?.();
    }
  }
}

/** Styled text that has to be cut loses its styles: cutting through escape codes would break them. */
function stripForCut(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "");
}

/** Runs argv on the real terminal and resolves with its exit code. */
export async function runInteractive(argv: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  const child = Bun.spawn(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit", env });
  return child.exited;
}
