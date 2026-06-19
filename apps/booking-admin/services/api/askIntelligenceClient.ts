import { authService } from "@/services/auth";
import {
  getAuthBearerToken,
  getAuthKitAccessToken,
  getSelectedOrganizationId,
} from "@/services/auth/sessionStore";

const ASK_API_BASE_URL = process.env.NEXT_PUBLIC_AUTH_API_URL || "https://api.localhost";

export type AskAnswerStatus =
  | "answered"
  | "partial"
  | "unavailable"
  | "needs_clarification"
  | "external_data_needed"
  | "not_authorized";

export type AskAnswer = {
  answerId: string;
  generatedAt: string;
  question: string;
  status: AskAnswerStatus;
  summary: string;
  blocks: Record<string, unknown>[];
  unavailableData: Array<Record<string, unknown>>;
  caveats: Array<Record<string, unknown>>;
  suggestedActions: Array<Record<string, unknown>>;
  followUpQuestions: string[];
  confidence?: {
    level?: string;
    reasons?: string[];
  };
};

export class AskIntelligenceClientError extends Error {
  retryable: boolean;

  constructor(message: string, options: { retryable: boolean }) {
    super(message);
    this.name = "AskIntelligenceClientError";
    this.retryable = options.retryable;
  }
}

export async function askIntelligence(
  question: string,
  bookingHotelId: string,
): Promise<AskAnswer> {
  const trimmedQuestion = question.trim();
  const trimmedHotelId = bookingHotelId.trim();

  if (!trimmedQuestion) {
    throw new AskIntelligenceClientError("Enter a question before asking.", {
      retryable: false,
    });
  }
  if (!trimmedHotelId) {
    throw new AskIntelligenceClientError("Select a property before using Ask Intelligence.", {
      retryable: false,
    });
  }

  const organizationId = await resolveOrganizationId();
  if (!organizationId) {
    throw new AskIntelligenceClientError(
      "Ask Intelligence needs an active hotel-group session for this property.",
      { retryable: true },
    );
  }

  const token = getAuthKitAccessToken() ?? getAuthBearerToken();
  const response = await fetch(`${ASK_API_BASE_URL}/api/ai/ask`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "X-Hotel-Id": trimmedHotelId,
    },
    body: JSON.stringify({
      question: trimmedQuestion,
      scope: {
        organizationId,
        bookingHotelId: trimmedHotelId,
        locale: browserLocale(),
      },
    }),
  });

  const body = await readJson(response);
  if (isAskAnswer(body)) return body;

  if (!response.ok) {
    throw safeAskError(response.status, body);
  }

  throw new AskIntelligenceClientError("Ask Intelligence returned an unexpected response.", {
    retryable: true,
  });
}

async function resolveOrganizationId(): Promise<string | null> {
  const existing = getSelectedOrganizationId();
  if (existing) return existing;

  try {
    await authService.ensureBookingCompatibilityToken();
  } catch {
    return null;
  }
  return getSelectedOrganizationId();
}

async function readJson(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function safeAskError(status: number, body: unknown): AskIntelligenceClientError {
  if (status === 401 || status === 403) {
    return new AskIntelligenceClientError(
      "Ask Intelligence is not available for this property with your current access.",
      { retryable: false },
    );
  }

  const code = record(body) && typeof body.code === "string" ? body.code : "";
  if (code === "rate_limited") {
    return new AskIntelligenceClientError("Ask Intelligence is busy. Try again in a moment.", {
      retryable: true,
    });
  }

  return new AskIntelligenceClientError("Ask Intelligence could not answer right now. Try again.", {
    retryable: true,
  });
}

function isAskAnswer(value: unknown): value is AskAnswer {
  return (
    record(value) &&
    typeof value.answerId === "string" &&
    typeof value.status === "string" &&
    typeof value.summary === "string" &&
    Array.isArray(value.blocks)
  );
}

function browserLocale(): string | undefined {
  if (typeof navigator === "undefined") return undefined;
  return navigator.language || undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
