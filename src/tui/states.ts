import type { BroadcastSummary, ExecState } from "../db.ts";
import { style } from "./text.ts";

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinner(): string {
  return SPIN[Math.floor(Date.now() / 1000) % SPIN.length]!;
}

export const STATE_LABEL: Record<ExecState, string> = {
  queued: "排队中",
  starting: "启动中",
  sending: "发送中",
  sent: "已发送",
  working: "执行中",
  blocked: "等待输入",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  lost: "已丢失",
};

const SYMBOL: Record<ExecState, string> = {
  queued: "…", starting: "⟳", sending: "⟳", sent: "⟳", working: "⟳", blocked: "?", completed: "✓", failed: "✗", cancelled: "⊘", lost: "✗",
};

/** "✓ 已完成", without colors: for text that is filtered, padded and cut. */
export function statePlain(state: ExecState): string {
  return `${SYMBOL[state]} ${STATE_LABEL[state]}`;
}

/** "进行中 · ✓1 ⟳1 ?1", without colors. */
export function summaryPlain(summary: BroadcastSummary): string {
  const c = summary.counts;
  const running = (c.working ?? 0) + (c.sent ?? 0) + (c.sending ?? 0) + (c.starting ?? 0);
  const failed = (c.failed ?? 0) + (c.lost ?? 0);
  const active = running + (c.queued ?? 0) + (c.blocked ?? 0);
  const overall = summary.total === 0 ? "空" : c.blocked ? "需要处理" : active > 0 ? "进行中" : failed > 0 ? "有失败" : (c.completed ?? 0) === summary.total ? "全部完成" : "已结束";
  const parts = [c.completed ? `✓${c.completed}` : "", running ? `⟳${running}` : "", c.blocked ? `?${c.blocked}` : "", c.queued ? `…${c.queued}` : "", failed ? `✗${failed}` : "", c.cancelled ? `⊘${c.cancelled}` : ""].filter(Boolean);
  return `${overall} · ${parts.join(" ")}`;
}

export function stateText(state: ExecState): string {
  const label = STATE_LABEL[state];
  switch (state) {
    case "completed":
      return style.green(`✓ ${label}`);
    case "working":
    case "sent":
    case "sending":
    case "starting":
      return style.cyan(`${spinner()} ${label}`);
    case "blocked":
      return style.magenta(`? ${label}`);
    case "queued":
      return style.gray(`… ${label}`);
    case "failed":
    case "lost":
      return style.red(`✗ ${label}`);
    case "cancelled":
      return style.gray(`⊘ ${label}`);
  }
}

/** ✓3 ⟳2 ?1 …1 ✗1 for the list. */
export function countsText(summary: BroadcastSummary): string {
  const c = summary.counts;
  const running = (c.working ?? 0) + (c.sent ?? 0) + (c.sending ?? 0) + (c.starting ?? 0);
  const failed = (c.failed ?? 0) + (c.lost ?? 0);
  const parts: string[] = [];
  if (c.completed) parts.push(style.green(`✓${c.completed}`));
  if (running) parts.push(style.cyan(`${spinner()}${running}`));
  if (c.blocked) parts.push(style.magenta(`?${c.blocked}`));
  if (c.queued) parts.push(style.gray(`…${c.queued}`));
  if (failed) parts.push(style.red(`✗${failed}`));
  if (c.cancelled) parts.push(style.gray(`⊘${c.cancelled}`));
  return parts.join(" ");
}

/** The broadcast's overall state, for the list. */
export function overallText(summary: BroadcastSummary): string {
  const c = summary.counts;
  const active = (c.queued ?? 0) + (c.starting ?? 0) + (c.sending ?? 0) + (c.sent ?? 0) + (c.working ?? 0) + (c.blocked ?? 0);
  if (summary.total === 0) return style.gray("空");
  if (c.blocked) return style.magenta("需要处理");
  if (active > 0) return style.cyan("进行中");
  if ((c.failed ?? 0) + (c.lost ?? 0) > 0) return style.red("有失败");
  if ((c.completed ?? 0) === summary.total) return style.green("全部完成");
  return style.gray("已结束");
}
