const SAFE_CODE = /^[a-z][a-z0-9_]{0,79}$/;

function safeCode(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_CODE.test(value) ? value : undefined;
}

// Never log provider messages, stacks, headers, or raw data: they can contain credentials/PII.
export function workosErrorDiagnostics(error: unknown) {
  const value = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  // The reasons WorkOS lists for a refused request, such as email_not_available (VAY-2250).
  const errorCodes = Array.isArray(value.errors)
    ? value.errors
        .slice(0, 10)
        .map((detail) => safeCode((detail as { code?: unknown } | null)?.code))
        .filter((code): code is string => code !== undefined)
    : [];
  return {
    code: safeCode(value.code ?? value.error),
    errorCodes: errorCodes.length > 0 ? errorCodes : undefined,
    status:
      typeof value.status === "number" &&
      Number.isInteger(value.status) &&
      value.status >= 400 &&
      value.status <= 599
        ? value.status
        : undefined,
    requestId:
      typeof value.requestID === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value.requestID)
        ? value.requestID
        : undefined,
  };
}
