// VAY-2508: which arguments of an AI action reach its log row. Derived from the action's own
// input schema, as the JSON Schema the AI is shown, so the log and the tool definition can not
// drift apart. Only ids, dates, enum values and booleans (a two-value enum) are declared; free
// text, numbers and anything else is never declared, so it is never stored (Flamur, 2026-11-20).
import { z } from "zod";

import type { AiArgumentKind } from "./actionLog.js";

type JsonSchema = {
  type?: string | string[];
  format?: string;
  enum?: readonly unknown[];
  const?: unknown;
  items?: JsonSchema;
  anyOf?: readonly JsonSchema[];
  properties?: Record<string, JsonSchema>;
};

const cache = new WeakMap<z.ZodType, Readonly<Record<string, AiArgumentKind>>>();

/** The argument kinds of an object input schema, one per top-level key it may keep. */
export function argumentKindsOf(input: z.ZodType): Readonly<Record<string, AiArgumentKind>> {
  const cached = cache.get(input);
  if (cached) return cached;
  const schema = z.toJSONSchema(input, { io: "input", unrepresentable: "any" }) as JsonSchema;
  const kinds: Record<string, AiArgumentKind> = {};
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    const kind = kindOf(property);
    if (kind) kinds[key] = kind;
  }
  const frozen = Object.freeze(kinds);
  cache.set(input, frozen);
  return frozen;
}

function kindOf(schema: JsonSchema): AiArgumentKind | null {
  if (schema.anyOf) {
    // optional and nullable fields: [the field, { type: "null" }]
    const options = schema.anyOf.filter((option) => option.type !== "null");
    return options.length === 1 ? kindOf(options[0]!) : null;
  }
  const values = schema.enum ?? ("const" in schema ? [schema.const] : undefined);
  if (values?.length && values.every((value) => typeof value === "string")) {
    return { oneOf: values as string[] };
  }
  if (schema.type === "boolean") return "flag";
  if (schema.type !== "string" && schema.type !== "array") return null;
  if (schema.type === "array") return schema.items && kindOf(schema.items) === "id" ? "ids" : null;
  if (schema.format === "uuid") return "id";
  if (schema.format === "date" || schema.format === "date-time") return "date";
  return null;
}
