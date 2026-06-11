export const ASK_CONTRACT_VERSION = "ask-intelligence-evidence.v1";

export type AskStatus =
  | "answered"
  | "partial"
  | "needs_clarification"
  | "unavailable"
  | "external_data_needed"
  | "not_authorized";

export type AskScope = {
  organizationId: string;
  bookingHotelId?: string;
  pmsHotelId?: string;
  dateRange?: { from: string; to: string };
  locale?: string;
  currency?: string;
};

export type AskConfidence = {
  level: "high" | "medium" | "low" | "unknown";
  reasons: string[];
};

export type AskAnswer = {
  answerId: string;
  contractVersion: typeof ASK_CONTRACT_VERSION;
  generatedAt: string;
  conversationId: string;
  runId: string;
  question: string;
  scope: AskScope;
  status: AskStatus;
  summary: string;
  blocks: Record<string, unknown>[];
  evidenceReferences: Record<string, unknown>[];
  unavailableData: Record<string, unknown>[];
  caveats: Record<string, unknown>[];
  confidence: AskConfidence;
  suggestedActions: Record<string, unknown>[];
  followUpQuestions: string[];
  audit: {
    requestId: string;
    actorInternalUserId: string | null;
    organizationId: string | null;
    toolCallIds: string[];
    deniedToolCallIds: string[];
  };
};

export type AskAuditRecord = Pick<AskAnswer, "answerId" | "generatedAt" | "question" | "status"> & {
  requestId: string;
  actorInternalUserId: string | null;
  organizationId: string | null;
  bookingHotelId: string | null;
};

export type AskAuditRepository = {
  recordAskRun(record: AskAuditRecord): Promise<void>;
  close?(): Promise<void>;
};
