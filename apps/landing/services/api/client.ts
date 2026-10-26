// The contact form's API client. Landing has no sign-in, so it sends no token. Moved here from
// the Marketplace shared package (VAY-2270) with only what the contact form uses. It posts to
// the TypeScript API's contact intake (VAY-2286); production builds pass next-api.vayada.com.

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "https://api.localhost";

export interface ApiError {
  detail?: unknown;
  message?: string;
  error?: string;
}

export class ApiErrorResponse extends Error {
  status: number;
  data: ApiError;

  constructor(status: number, data: ApiError) {
    super(
      (typeof data.detail === "string" ? data.detail : null) ||
        data.message ||
        data.error ||
        `API Error: ${status}`,
    );
    this.name = "ApiErrorResponse";
    this.status = status;
    this.data = data;
  }
}

async function post<T>(endpoint: string, data?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (response.ok && response.status === 204) return undefined as T;

  const text = await response.text();
  let body: unknown = text || null;
  if (text && response.headers.get("content-type")?.includes("application/json")) {
    try {
      body = JSON.parse(text);
    } catch {
      if (response.ok) return undefined as T;
    }
  }
  if (!response.ok) {
    throw new ApiErrorResponse(
      response.status,
      body && typeof body === "object"
        ? (body as ApiError)
        : { detail: typeof body === "string" && body ? body : `API Error: ${response.status}` },
    );
  }
  return body as T;
}

export const apiClient = { post };
