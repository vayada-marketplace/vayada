export type VayadaAuthState =
  | "invalid_credentials"
  | "email_verification_required"
  | "organization_selection_required"
  | "mfa_required"
  | "sso_required"
  | "auth_unavailable"
  | "auth_failed";

export type VayadaAuthStateOrganization = {
  id: string;
  name?: string;
};

export type VayadaAuthStateResponse = {
  state: VayadaAuthState;
  message: string;
  pendingAuthenticationToken?: string;
  email?: string;
  emailVerificationId?: string;
  organizations?: VayadaAuthStateOrganization[];
  connectionIds?: string[];
};

const STATE_MESSAGES: Record<VayadaAuthState, string> = {
  invalid_credentials: "Email or password is incorrect.",
  email_verification_required: "Verify your email address to continue.",
  organization_selection_required: "Choose a workspace to continue.",
  mfa_required: "Additional verification is required.",
  sso_required: "Single sign-on is required for this account.",
  auth_unavailable: "Signing in is taking longer than usual. Please try again in a moment.",
  auth_failed: "Authentication failed. Please try again.",
};

/**
 * VAY-2604: WorkOS didn't answer in time, couldn't be reached, rate-limited us or failed on its side.
 * Nothing is wrong with the person's session or password, so callers answer "try again" (503) and
 * never clear the session.
 */
export class AuthProviderUnavailableError extends Error {
  override name = "AuthProviderUnavailableError";
  constructor(
    readonly reason: string,
    options?: { cause?: unknown },
  ) {
    super(`WorkOS is unavailable (${reason})`, options);
  }
}

/** Errors that say WorkOS is slow or down, not that the request was wrong (SDK 10.x shapes). */
export function isWorkOSUnavailableError(error: unknown, depth = 0): boolean {
  if (error instanceof AuthProviderUnavailableError) return true;
  if (!isRecord(error)) return false;
  // The SDK turns its own timeout into status 408 ("Request timeout"); 429 and 5xx are WorkOS-side
  // too. A ParseError (a 5xx page that isn't JSON) carries the status as rawStatus.
  const status = [error.status, error.rawStatus, isRecord(error.response) && error.response.status]
    .filter((value): value is number => typeof value === "number")
    .at(0);
  if (status === 408 || status === 429 || (status !== undefined && status >= 500 && status <= 599))
    return true;
  // fetch() fails with TypeError("fetch failed") and the network error as its cause.
  if (error instanceof TypeError && (error.message === "fetch failed" || isRecord(error.cause)))
    return true;
  if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  // jose's remote key set (used to check the session): timed out, or WorkOS answered without a 200.
  if (error.code === "ERR_JWKS_TIMEOUT") return true;
  if (
    error.code === "ERR_JOSE_GENERIC" &&
    typeof error.message === "string" &&
    error.message.includes("JSON Web Key Set")
  )
    return true;
  // The SDK wraps errors it can't map (such as that ParseError) as Error("Unexpected error…", { cause }).
  return depth < 2 && isWorkOSUnavailableError(error.cause, depth + 1);
}

/** The same error as an AuthProviderUnavailableError, for the app's error handler to answer 503. */
export function asAuthProviderUnavailable(error: unknown): AuthProviderUnavailableError {
  return error instanceof AuthProviderUnavailableError
    ? error
    : new AuthProviderUnavailableError("workos_unavailable", { cause: error });
}

export function mapWorkOSAuthError(error: unknown): VayadaAuthStateResponse {
  const payloads = errorPayloads(error);
  const code = readString(payloads, ["code", "error"]);

  switch (code) {
    case "invalid_credentials":
    case "invalid_grant":
      return stateResponse("invalid_credentials");
    case "email_verification_required":
      return stateResponse("email_verification_required", {
        pendingAuthenticationToken: readString(payloads, [
          "pendingAuthenticationToken",
          "pending_authentication_token",
        ]),
        email: readString(payloads, ["email"]),
        emailVerificationId: readString(payloads, ["emailVerificationId", "email_verification_id"]),
      });
    case "organization_selection_required":
      return stateResponse("organization_selection_required", {
        pendingAuthenticationToken: readString(payloads, [
          "pendingAuthenticationToken",
          "pending_authentication_token",
        ]),
        organizations: readOrganizations(payloads),
      });
    case "mfa_challenge":
    case "mfa_enrollment":
    case "mfa_verification":
    case "mfa_required":
      return stateResponse("mfa_required", {
        pendingAuthenticationToken: readString(payloads, [
          "pendingAuthenticationToken",
          "pending_authentication_token",
        ]),
      });
    case "sso_required":
    case "organization_authentication_methods_required":
      return stateResponse("sso_required", {
        connectionIds: readStringArray(payloads, [
          "connectionIds",
          "connection_ids",
          "ssoConnectionIds",
          "sso_connection_ids",
        ]),
      });
    default:
      return stateResponse(isWorkOSUnavailableError(error) ? "auth_unavailable" : "auth_failed");
  }
}

/** The answer for "WorkOS is unavailable", for routes that have no state of their own. */
export function authUnavailableResponse(): VayadaAuthStateResponse {
  return stateResponse("auth_unavailable");
}

function stateResponse(
  state: VayadaAuthState,
  details: Omit<VayadaAuthStateResponse, "state" | "message"> = {},
): VayadaAuthStateResponse {
  return {
    state,
    message: STATE_MESSAGES[state],
    ...definedEntries(details),
  };
}

function errorPayloads(error: unknown): Array<Record<string, unknown>> {
  if (!isRecord(error)) return [];
  return [
    error,
    ...["rawData", "raw_data", "body", "responseBody", "response"]
      .map((key) => error[key])
      .filter(isRecord),
  ];
}

function readString(payloads: Array<Record<string, unknown>>, keys: string[]): string | undefined {
  for (const payload of payloads) {
    for (const key of keys) {
      const value = payload[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return undefined;
}

function readStringArray(
  payloads: Array<Record<string, unknown>>,
  keys: string[],
): string[] | undefined {
  for (const payload of payloads) {
    for (const key of keys) {
      const value = payload[key];
      if (!Array.isArray(value)) continue;
      const strings = value.filter((item): item is string => typeof item === "string");
      if (strings.length > 0) return strings;
    }
  }
  return undefined;
}

function readOrganizations(
  payloads: Array<Record<string, unknown>>,
): VayadaAuthStateOrganization[] | undefined {
  for (const payload of payloads) {
    const value = payload.organizations;
    if (!Array.isArray(value)) continue;
    const organizations = value.flatMap((item) => {
      if (!isRecord(item)) return [];
      const id = readString([item], ["id", "organizationId", "organization_id"]);
      if (!id) return [];
      return [
        {
          id,
          name: readString([item], ["name"]),
        },
      ];
    });
    if (organizations.length > 0) return organizations;
  }
  return undefined;
}

function definedEntries<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
