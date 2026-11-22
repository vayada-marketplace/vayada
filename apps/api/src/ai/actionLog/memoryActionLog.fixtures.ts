// An in-memory AI action log for tests (VAY-2508): each row exactly as the database would get it
// (toAiToolCallRow), with the column values named.
import { toAiToolCallRow, type AiActionEntry, type AiActionLog } from "./actionLog.js";

const COLUMNS = [
  "occurredAt",
  "organizationId",
  "propertyId",
  "userId",
  "surface",
  "client",
  "connectionId",
  "conversationId",
  "action",
  "actionVersion",
  "group",
  "arguments",
  "recordsRead",
  "recordsChanged",
  "outcome",
  "errorCode",
  "latencyMs",
  "sensitive",
  "requestId",
  "correlationId",
  "idempotencyKeyHash",
  "operationId",
  "externalCallId",
  "model",
] as const;
const JSON_COLUMNS = new Set<string>(["arguments", "recordsRead", "recordsChanged"]);

export type LoggedRow = Record<(typeof COLUMNS)[number], unknown>;

export function memoryAiActionLog(): AiActionLog & { rows: LoggedRow[] } {
  const rows: LoggedRow[] = [];
  return {
    rows,
    async record(entry: AiActionEntry) {
      const values = toAiToolCallRow(entry);
      rows.push(
        Object.fromEntries(
          COLUMNS.map((column, index) => {
            const value = values[index];
            return [column, JSON_COLUMNS.has(column) ? JSON.parse(String(value)) : value];
          }),
        ) as LoggedRow,
      );
    },
  };
}
