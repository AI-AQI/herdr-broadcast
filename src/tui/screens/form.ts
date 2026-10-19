/** A form of single-line fields, for the small dialogs (rename, add machine). */
import { type App, type Screen } from "../app.ts";
import { TextInput } from "../input.ts";
import type { Key } from "../keys.ts";
import type { Line } from "../term.ts";
import { pad, style } from "../text.ts";

export interface FormField {
  label: string;
  value?: string;
  placeholder?: string;
  help?: string;
}

export class FormScreen implements Screen {
  private inputs: TextInput[];
  private focus = 0;

  constructor(
    private readonly app: App,
    private readonly heading: string,
    private readonly fields: FormField[],
    private readonly submit: (values: string[]) => void | Promise<void>,
    private readonly intro: string[] = [],
  ) {
    this.inputs = fields.map((f) => new TextInput(f.value ?? "", f.placeholder ?? ""));
  }

  title(): string {
    return this.heading;
  }

  hints(): string {
    return `${this.fields.length > 1 ? "↑↓/Tab 切换字段  " : ""}Enter 确定  Esc 取消`;
  }

  render(cols: number): Line[] {
    const out: Line[] = this.intro.map((l) => style.dim(` ${l}`));
    if (out.length > 0) out.push("");
    this.fields.forEach((field, i) => {
      const focused = i === this.focus;
      out.push(`${focused ? style.cyan("›") : " "} ${pad(field.label, 14)} ${this.inputs[i]!.render(cols - 20, focused)}`);
      if (field.help) out.push(style.dim(`                 ${field.help}`));
    });
    return out;
  }

  async key(key: Key): Promise<void> {
    if (key.name === "escape") {
      this.app.pop();
      return;
    }
    if (key.name === "up" || key.name === "backtab") {
      this.focus = Math.max(0, this.focus - 1);
      return;
    }
    if (key.name === "down" || key.name === "tab") {
      this.focus = Math.min(this.fields.length - 1, this.focus + 1);
      return;
    }
    if (key.name === "enter") {
      const values = this.inputs.map((i) => i.value.trim());
      this.app.pop();
      await this.submit(values);
      return;
    }
    this.inputs[this.focus]!.key(key);
  }
}
