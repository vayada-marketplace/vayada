/** One ApiClient class for the TypeScript public Booking Web API (bookingWebPublic). */

export const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

class ApiError extends Error {
  status: number;
  detail: unknown;
  constructor(message: string, status: number, detail: unknown) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

export type ApiRequestInit = RequestInit & {
  next?: {
    revalidate?: number | false;
    tags?: string[];
  };
};

class ApiClient {
  constructor(private baseUrl: string) {}

  get baseURL(): string {
    return this.baseUrl;
  }

  async get<T>(path: string, init?: ApiRequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, init);
    return parse<T>(res);
  }

  async post<T>(path: string, body?: unknown, init?: ApiRequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      method: "POST",
      headers: { "Content-Type": "application/json", ...init?.headers },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return parse<T>(res);
  }
}

// Pull a human-readable string out of an error body. FastAPI returns
// `{detail: "..."}` for raised HTTPExceptions but `{detail: [{loc,msg,...}]}`
// for request-validation (422) errors — the list shape is why the old code
// fell back to a raw "API error: POST 422".
function messageFromDetail(detail: unknown, status: number): string | null {
  if (!detail || typeof detail !== "object") return null;
  if (!("detail" in detail)) return guestMessage(detail, status);
  const d = (detail as { detail: unknown }).detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d)) {
    const msgs = d
      .map((e) =>
        e && typeof e === "object" && "msg" in e ? String((e as { msg: unknown }).msg) : "",
      )
      .filter(Boolean);
    if (msgs.length) return msgs.join("; ");
  }
  return null;
}

// The TypeScript API answers `{statusCode, error, message, code?}` (VAY-2308). A 4xx message is
// written for guests; Fastify's own (FST_* codes, unknown routes) and every 5xx message are not.
function guestMessage(body: object, status: number): string | null {
  const { message, code } = body as { message?: unknown; code?: unknown };
  if (status >= 500 || typeof message !== "string" || !message.trim()) return null;
  if (typeof code === "string" && code.startsWith("FST_")) return null;
  if (/^Route \w+:\S* not found$/.test(message)) return null;
  return message;
}

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail: unknown = null;
    try {
      detail = await res.json();
    } catch {}
    // Never surface a raw "API error: POST 422" to the user. Callers that
    // render errors (e.g. the checkout payment step) classify on
    // err.status / err.detail and map to friendly localized copy; this
    // message is only the last-resort copy.
    const message = messageFromDetail(detail, res.status) || GENERIC_ERROR_MESSAGE;
    throw new ApiError(message, res.status, detail);
  }
  return res.json();
}

// Most browser requests stay same-origin and are proxied by Next.js. This keeps
// verified hotel custom domains functional without trusting arbitrary origins
// in the public API's CORS policy.
export const bookingWebPublic = new ApiClient("");

/**
 * Straight to the API, for calls whose per-address limit must count the guest: through this
 * site's proxy every guest shares this server's address (VAY-2214, VAY-2220). Same-origin when
 * the API address isn't configured (browser specs, plain local dev).
 */
export function bookingWebDirect(): ApiClient {
  // A plain read, so Next.js inlines the build-time value.
  const configured = process.env.NEXT_PUBLIC_BOOKING_WEB_API_URL;
  return new ApiClient(configured ? configured.replace(/\/+$/, "") : "");
}
export { ApiError };
