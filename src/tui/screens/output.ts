/** An execution's agent output, read through Herdr and refreshed while shown. */
import type { Execution } from "../../db.ts";
import { agentRead } from "../../herdr.ts";
import { isChar, type App, type Screen } from "../app.ts";
import type { Key } from "../keys.ts";
import type { Line } from "../term.ts";
import { sanitize, style, wrap } from "../text.ts";

export class OutputScreen implements Screen {
  private text = "";
  private error: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private scrollBack = 0;
  private reading = false;

  constructor(private readonly app: App, private readonly execution: Execution) {}

  title(): string {
    return `输出 · ${this.execution.agent_kind ?? "agent"} ${this.execution.pane_id ?? ""}`;
  }

  hints(): string {
    return "↑↓ 滚动  r 刷新  Enter 跳到该 agent  Esc 返回（每 3 秒自动刷新）";
  }

  enter(): void {
    void this.load();
    this.timer = setInterval(() => void this.load(), 3_000);
  }

  leave(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async load(): Promise<void> {
    if (this.reading || !this.execution.pane_id) return;
    this.reading = true;
    try {
      this.text = sanitize(await agentRead(this.execution.machine_id, this.execution.pane_id, 200));
      this.error = null;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.reading = false;
      this.app.redraw();
    }
  }

  render(cols: number, rows: number): Line[] {
    if (this.error) return [style.red(` ${this.error}`)];
    const lines = wrap(this.text.replace(/\s+$/, ""), cols - 2);
    this.scrollBack = Math.max(0, Math.min(this.scrollBack, Math.max(0, lines.length - rows)));
    const end = lines.length - this.scrollBack;
    return lines.slice(Math.max(0, end - rows), end).map((l) => ` ${l}`);
  }

  async key(key: Key): Promise<void> {
    if (key.name === "escape" || key.name === "left" || isChar(key, "q", "b")) this.app.pop();
    else if (key.name === "up" || isChar(key, "k")) this.scrollBack += 1;
    else if (key.name === "down" || isChar(key, "j")) this.scrollBack = Math.max(0, this.scrollBack - 1);
    else if (key.name === "pageup") this.scrollBack += 10;
    else if (key.name === "pagedown") this.scrollBack = Math.max(0, this.scrollBack - 10);
    else if (isChar(key, "r")) await this.load();
    else if (key.name === "enter") this.app.say(await this.app.engine.focus(this.execution));
  }
}
