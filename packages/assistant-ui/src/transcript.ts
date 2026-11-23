import type { ConversationView, TurnStatus } from "./assistantApi";

/**
 * What the panel shows of a stored chat (VAY-2519). Everything comes from what the API stored:
 * the person's questions (without vayada's note), the AI's text, one progress line per tool call
 * with its result, and how each turn ended when it didn't simply finish. Thinking, tool inputs and
 * tool answers are never shown as text.
 */
export type ToolLineStatus = "running" | "ok" | "failed" | "skipped";

export type TranscriptItem =
  | { kind: "question"; key: string; text: string }
  | { kind: "progress"; key: string; tool: string; status: ToolLineStatus }
  | { kind: "answer"; key: string; text: string; at: string }
  | {
      kind: "ended";
      key: string;
      turnId: string;
      status: Exclude<TurnStatus, "running" | "done">;
      reason: string | null;
    };

type Part = Record<string, unknown>;

const isRecord = (value: unknown): value is Part =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const partsOf = (content: unknown): Part[] =>
  Array.isArray(content) ? content.filter(isRecord) : [];

/** vayada's note sent with a question (today's date, the property): not the person's words. */
const isContextNote = (part: Part) => {
  const options = part["providerOptions"];
  return isRecord(options) && isRecord(options["vayada"]) && options["vayada"]["context"] === true;
};

export function questionText(content: unknown): string {
  if (typeof content === "string") return content;
  return partsOf(content)
    .filter((part) => part["type"] === "text" && !isContextNote(part))
    .map((part) => String(part["text"] ?? ""))
    .join("\n");
}

function resultStatus(output: unknown): ToolLineStatus {
  if (!isRecord(output)) return "failed";
  if (output["type"] !== "error-json" && output["type"] !== "error-text") return "ok";
  const value = output["value"];
  const code = isRecord(value) ? (value["code"] ?? value["error"]) : undefined;
  // Never ran: cut off, stopped, a repeat, a restart.
  return code === "not_run" || code === "interrupted" || code === "repeat_limit" || code === "stopped"
    ? "skipped"
    : "failed";
}

export function transcriptOf(view: ConversationView): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const lineOf = new Map<string, Extract<TranscriptItem, { kind: "progress" }>>();
  const turns = new Map(view.turns.map((turn) => [turn.id, turn]));
  let currentTurn: string | undefined;

  const closeTurn = (turnId: string | undefined) => {
    const turn = turnId ? turns.get(turnId) : undefined;
    if (!turn || turn.status === "running" || turn.status === "done") return;
    items.push({
      kind: "ended",
      key: `ended-${turn.id}`,
      turnId: turn.id,
      status: turn.status,
      reason: turn.endReason,
    });
  };

  for (const row of view.messages) {
    if (row.turnId !== currentTurn) {
      closeTurn(currentTurn);
      currentTurn = row.turnId;
    }
    const { role, content } = row.message;
    if (role === "user") {
      const text = questionText(content);
      if (text.trim()) items.push({ kind: "question", key: `q-${row.seq}`, text });
    } else if (role === "assistant") {
      const parts = typeof content === "string" ? [{ type: "text", text: content }] : partsOf(content);
      // Progress lines first, then the text: the panel shows what was looked at, then the answer.
      for (const part of parts.filter((each) => each["type"] === "tool-call")) {
        const line = {
          kind: "progress" as const,
          key: `t-${String(part["toolCallId"])}`,
          tool: String(part["toolName"]),
          status: "running" as ToolLineStatus,
        };
        lineOf.set(String(part["toolCallId"]), line);
        items.push(line);
      }
      const text = parts
        .filter((part) => part["type"] === "text" && typeof part["text"] === "string")
        .map((part) => String(part["text"]))
        .join("\n")
        .trim();
      if (text) items.push({ kind: "answer", key: `a-${row.seq}`, text, at: row.createdAt });
    } else {
      for (const part of partsOf(content)) {
        const line = lineOf.get(String(part["toolCallId"]));
        if (line && part["type"] === "tool-result") line.status = resultStatus(part["output"]);
      }
    }
  }
  closeTurn(currentTurn);
  return items;
}

/** The turn still running, if any (after a reload mid-answer the panel follows it). */
export function runningTurn(view: ConversationView) {
  return view.turns.find((turn) => turn.status === "running");
}
