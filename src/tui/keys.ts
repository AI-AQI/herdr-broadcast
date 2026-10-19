/** Raw terminal input -> keys. Handles CSI/SS3 sequences, Alt+key, Ctrl+letter and bracketed paste. */

export interface Key {
  /** "char" for text; otherwise up, down, left, right, home, end, pageup, pagedown, enter, tab,
   * backtab, backspace, delete, escape, newline (Alt+Enter / Ctrl+J), paste, or a letter with ctrl */
  name: string;
  /** the text of a "char" or "paste" key */
  text?: string;
  ctrl?: boolean;
  alt?: boolean;
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

const CSI_KEYS: Record<string, string> = {
  A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", Z: "backtab",
  "1~": "home", "7~": "home", "4~": "end", "8~": "end", "3~": "delete", "5~": "pageup", "6~": "pagedown", "2~": "insert",
};

export class KeyParser {
  private paste: string | null = null;

  /** Splits one read into keys. A paste may span several reads. */
  feed(data: string): Key[] {
    const keys: Key[] = [];
    let i = 0;
    while (i < data.length) {
      if (this.paste !== null) {
        const end = data.indexOf(PASTE_END, i);
        if (end === -1) {
          this.paste += data.slice(i);
          return keys;
        }
        this.paste += data.slice(i, end);
        keys.push({ name: "paste", text: this.paste.replace(/\r\n?/g, "\n") });
        this.paste = null;
        i = end + PASTE_END.length;
        continue;
      }
      if (data.startsWith(PASTE_START, i)) {
        this.paste = "";
        i += PASTE_START.length;
        continue;
      }
      const ch = data[i]!;
      if (ch === "\x1b") {
        const next = data[i + 1];
        if (next === undefined) {
          keys.push({ name: "escape" });
          i += 1;
          continue;
        }
        if (next === "[" || next === "O") {
          // CSI / SS3: parameters, then one final byte
          let j = i + 2;
          while (j < data.length && /[0-9;?<>=]/.test(data[j]!)) j += 1;
          const final = data[j];
          if (final === undefined) {
            i = data.length;
            continue;
          }
          const params = data.slice(i + 2, j);
          const mods = params.includes(";") ? Number(params.split(";")[1]) - 1 : 0;
          const base = final === "~" ? `${params.split(";")[0]}~` : final;
          const name = CSI_KEYS[base];
          if (name) keys.push({ name, ...(mods & 4 ? { ctrl: true } : {}), ...(mods & 2 ? { alt: true } : {}) });
          i = j + 1;
          continue;
        }
        if (next === "\r" || next === "\n") {
          keys.push({ name: "newline" });
          i += 2;
          continue;
        }
        if (next === "\x7f") {
          keys.push({ name: "backspace", alt: true });
          i += 2;
          continue;
        }
        if (next === "\x1b") {
          keys.push({ name: "escape" });
          i += 1;
          continue;
        }
        const cp = data.codePointAt(i + 1)!;
        const text = String.fromCodePoint(cp);
        keys.push({ name: "char", text, alt: true });
        i += 1 + text.length;
        continue;
      }
      if (ch === "\r") {
        keys.push({ name: "enter" });
        i += data[i + 1] === "\n" ? 2 : 1;
        continue;
      }
      if (ch === "\n") {
        keys.push({ name: "newline" });
        i += 1;
        continue;
      }
      if (ch === "\t") {
        keys.push({ name: "tab" });
        i += 1;
        continue;
      }
      if (ch === "\x7f" || ch === "\b") {
        keys.push({ name: "backspace" });
        i += 1;
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        keys.push({ name: String.fromCharCode(code + 96), ctrl: true });
        i += 1;
        continue;
      }
      // a run of printable text (typed fast, or an IME commit) becomes one key per character
      const cp = data.codePointAt(i)!;
      const text = String.fromCodePoint(cp);
      keys.push({ name: "char", text });
      i += text.length;
    }
    return keys;
  }
}
