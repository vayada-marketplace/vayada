import type { RequestContext } from "@vayada/backend-auth";

import type { AskAnswer, AskScope } from "./ask.js";

export const ASK_PROMPT_VERSION = "ask-prompt.v1";
export const ASK_ANSWER_SCHEMA_VERSION = "ask-answer-schema.v1";

/**
 * Redacted prior-turn summary sent to the model instead of full transcripts,
 * per the VAY-736 conversation-state rules. Never carries raw guest records,
 * payout details, tokens, or another tenant's data.
 */
export type AskConversationTurn = {
  question: string;
  answerSummary: string;
  status: AskAnswer["status"];
  evidenceIds: string[];
};

export type AskConversationState = {
  conversationId: string;
  clarifiedScope?: AskScope;
  priorTurns: AskConversationTurn[];
};

export type AskRunRequest = {
  question: string;
  scope: AskScope;
  conversationState?: AskConversationState;
};

/**
 * The only Ask Intelligence boundary route handlers and domain services may
 * depend on. Implementations own the agent loop, tool selection, structured
 * answer synthesis, confidence, and audit capture; callers never see the
 * model provider or agent SDK types.
 */
export type AskAgentRuntime = {
  answer(request: AskRunRequest, context: RequestContext): Promise<AskAnswer>;
};
