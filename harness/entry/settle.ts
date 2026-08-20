// settle.ts — extracted from harness/index.ts (Batch 5 of REFACTOR-PLAN.md).
// Pure helpers — identical to the original source.
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
/** The last assistant message's text (used to read the model's remaining estimate). */
/** Extract text from an assistant message's content (string or part array). */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as { type?: string; text?: string }[])
      .filter((p) => p?.type === "text")
      .map((p) => p.text ?? "")
      .join("\n");
  }
  return "";
}

export function lastAssistantText(ctx: ExtensionCommandContext): string {
  try {
    const entries = ctx.sessionManager.getEntries() ?? [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i] as { type?: string; message?: { role?: string; content?: unknown } } | undefined;
      if (e?.type === "message" && e.message?.role === "assistant") {
        const c = e.message.content;
        if (typeof c === "string") return c;
        if (Array.isArray(c)) {
          return (c as { type?: string; text?: string }[])
            .filter((p) => p?.type === "text")
            .map((p) => p.text ?? "")
            .join("\n");
        }
      }
    }
  } catch {
    /* ignore */
  }
  return "";
}
