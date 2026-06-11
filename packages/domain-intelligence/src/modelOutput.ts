import { z } from "zod";

/**
 * Model-facing output contract for an Ask run. Unlike `askAnswerSchema`
 * (the full envelope, owned by the runtime), this shape is compatible with
 * OpenAI strict structured outputs: every field is required, optionality is
 * expressed as `null`, and there are no open records. The composer maps this
 * payload plus the authorized evidence pack into the final `AskAnswer`; the
 * model never authors IDs, scope, audit, evidence, or confidence.
 */

export const askModelBlockSchema = z.strictObject({
  type: z.enum([
    "metric",
    "trend",
    "breakdown",
    "table",
    "explanation",
    "recommendation",
    "setup_gap",
    "risk",
    "action_suggestion",
  ]),
  metricKey: z.string().nullable(),
  value: z.number().nullable(),
  unit: z.enum(["percentage", "currency", "score", "count"]).nullable(),
  text: z.string().nullable(),
  evidenceIds: z.array(z.string()),
});

export const askModelCaveatSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
  evidenceIds: z.array(z.string()),
});

export const askModelSuggestedActionSchema = z.strictObject({
  type: z.enum([
    "view_report",
    "open_settings",
    "create_task",
    "adjust_rate_review",
    "contact_guest",
    "review_collaboration",
    "enable_feature",
    "request_enrichment",
  ]),
  label: z.string(),
  evidenceIds: z.array(z.string()),
});

export const askModelOutputSchema = z.strictObject({
  status: z.enum([
    "answered",
    "partial",
    "needs_clarification",
    "unavailable",
    "external_data_needed",
    "not_authorized",
  ]),
  summary: z.string(),
  blocks: z.array(askModelBlockSchema),
  caveats: z.array(askModelCaveatSchema),
  suggestedActions: z.array(askModelSuggestedActionSchema),
  followUpQuestions: z.array(z.string()),
});

export type AskModelBlock = z.infer<typeof askModelBlockSchema>;
export type AskModelCaveat = z.infer<typeof askModelCaveatSchema>;
export type AskModelSuggestedAction = z.infer<typeof askModelSuggestedActionSchema>;
export type AskModelOutput = z.infer<typeof askModelOutputSchema>;
