/**
 * One ApiClient class, instantiated once per backend:
 *   - bookingWebPublic: TypeScript public Booking Web read API
 *   - bookingEngine:   legacy booking API for checkout-adjacent calls
 *   - pms:             legacy PMS API for checkout/inventory calls not yet cut over
 *
 * Callers must pick the right namespace until the Booking Web cutover is
 * complete. The PMS_URL falls back to the booking-engine URL for environments
 * where one process serves both.
 */

class ApiError extends Error {
  status: number;
  detail: unknown;
  constructor(message: string, status: number, detail: unknown) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

class ApiClient {
  constructor(private baseUrl: string) {}

  get baseURL(): string {
    return this.baseUrl;
  }

  async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`);
    return parse<T>(res);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return parse<T>(res);
  }
}

// Pull a human-readable string out of an error body. FastAPI returns
// `{detail: "..."}` for raised HTTPExceptions but `{detail: [{loc,msg,...}]}`
// for request-validation (422) errors — the list shape is why the old code
// fell back to a raw "API error: POST 422".
function messageFromDetail(detail: unknown): string | null {
  if (!detail || typeof detail !== "object" || !("detail" in detail)) return null;
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

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail: unknown = null;
    try {
      detail = await res.json();
    } catch {}
    // Never surface a raw "API error: POST 422" to the user. Callers that
    // render errors (e.g. the checkout payment step) classify on
    // err.status / err.detail and map to friendly localized copy; this
    // message is only the last-resort fallback.
    const message = messageFromDetail(detail) || "Something went wrong. Please try again.";
    throw new ApiError(message, res.status, detail);
  }
  return res.json();
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";
const PMS_URL = process.env.NEXT_PUBLIC_PMS_URL || API_URL;
const BOOKING_WEB_PUBLIC_API_URL =
  process.env.NEXT_PUBLIC_BOOKING_WEB_API_URL || "https://api.localhost";

export const bookingWebPublic = new ApiClient(BOOKING_WEB_PUBLIC_API_URL);
export const bookingEngine = new ApiClient(API_URL);
export const pms = new ApiClient(PMS_URL);
export { ApiError };
