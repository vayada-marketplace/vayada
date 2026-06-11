import { z } from "zod";

import { ASK_CONTRACT_VERSION, type AskAnswer } from "./ask.js";

const openRecord = z.record(z.string(), z.unknown());

const askScopeSchema = z.strictObject({
  organizationId: z.string().min(1),
  bookingHotelId: z.string().min(1).optional(),
  pmsHotelId: z.string().min(1).optional(),
  dateRange: z.strictObject({ from: z.string().min(1), to: z.string().min(1) }).optional(),
  locale: z.string().min(1).optional(),
  currency: z.string().min(1).optional(),
});

/**
 * Strict schema for the only successful final output of an Ask run, applied
 * as a post-hoc `parse()` over composed answers. Domain validation (every
 * material claim cites evidence or unavailable data) is owned by the answer
 * composer. This shape is NOT directly usable as an OpenAI strict
 * structured-output schema (optional fields and open records are rejected
 * there); the agent runtime defines a provider-compatible output variant and
 * maps it into this envelope.
 */
export const askAnswerSchema = z.strictObject({
  answerId: z.string().min(1),
  contractVersion: z.literal(ASK_CONTRACT_VERSION),
  generatedAt: z.string().min(1),
  conversationId: z.string().min(1),
  runId: z.string().min(1),
  question: z.string().min(1),
  scope: askScopeSchema,
  status: z.enum([
    "answered",
    "partial",
    "needs_clarification",
    "unavailable",
    "external_data_needed",
    "not_authorized",
  ]),
  summary: z.string(),
  blocks: z.array(openRecord),
  evidenceReferences: z.array(openRecord),
  unavailableData: z.array(openRecord),
  caveats: z.array(openRecord),
  confidence: z.strictObject({
    level: z.enum(["high", "medium", "low", "unknown"]),
    reasons: z.array(z.string()),
  }),
  suggestedActions: z.array(openRecord),
  followUpQuestions: z.array(z.string()),
  audit: z.strictObject({
    requestId: z.string().min(1),
    actorInternalUserId: z.string().nullable(),
    organizationId: z.string().nullable(),
    toolCallIds: z.array(z.string()),
    deniedToolCallIds: z.array(z.string()),
  }),
});

export type AskAnswerSchemaOutput = z.infer<typeof askAnswerSchema>;

type AssertAssignable<Target, Source extends Target> = Source;
type _SchemaOutputMatchesAskAnswer = AssertAssignable<AskAnswer, AskAnswerSchemaOutput>;
type _AskAnswerMatchesSchemaOutput = AssertAssignable<AskAnswerSchemaOutput, AskAnswer>;
