/**
 * The Vayada API client for platform calls that need the signed-in admin's AuthKit token (media
 * uploads). Moved here from the Marketplace shared package (VAY-2270) without its Marketplace
 * parts: a 401 forces one token refresh and one retry; there is no redirect to /login.
 */

export const VAYADA_API_BASE_URL =
  process.env.NEXT_PUBLIC_VAYADA_API_URL ||
  process.env.NEXT_PUBLIC_AUTH_API_URL ||
  "https://api.localhost";

type VayadaBearerTokenProvider = (
  signal?: AbortSignal,
  forceRefresh?: boolean,
) => string | null | Promise<string | null>;
let vayadaBearerTokenProvider: VayadaBearerTokenProvider | null = null;

export function setVayadaApiBearerTokenProvider(provider: VayadaBearerTokenProvider | null): void {
  vayadaBearerTokenProvider = provider;
}

async function vayadaBearerToken(signal?: AbortSignal, forceRefresh = false) {
  return (await vayadaBearerTokenProvider?.(signal, forceRefresh)) ?? null;
}

export interface VayadaApiError {
  detail?:
    | string
    | Array<{
        loc: (string | number)[];
        msg: string;
        type: string;
      }>;
  message?: string;
  error?: string;
  code?: string;
  category?: string;
}

export class VayadaApiErrorResponse extends Error {
  status: number;
  data: VayadaApiError;

  constructor(status: number, data: VayadaApiError) {
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

function wasRequestAborted(error: unknown, signal?: AbortSignal | null): boolean {
  return (
    signal?.aborted === true &&
    (error === signal.reason ||
      (typeof error === "object" &&
        error !== null &&
        "name" in error &&
        error.name === "AbortError"))
  );
}

export class VayadaApiClient {
  constructor(private readonly baseURL: string = VAYADA_API_BASE_URL) {}

  private async fetchWithTokenRefresh(
    url: string,
    endpoint: string,
    config: RequestInit,
  ): Promise<Response> {
    const response = await fetch(url, config);
    if (response.status !== 401 || endpoint.startsWith("/auth/")) return response;

    const refreshedToken = await vayadaBearerToken(config.signal ?? undefined, true);
    if (!refreshedToken) return response;
    await response.body?.cancel().catch(() => undefined);
    return fetch(url, {
      ...config,
      headers: {
        ...(config.headers as Record<string, string>),
        Authorization: `Bearer ${refreshedToken}`,
      },
    });
  }

  async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseURL}${endpoint}`;
    const token = !endpoint.startsWith("/auth/")
      ? await vayadaBearerToken(options.signal ?? undefined)
      : null;

    const isFormData = typeof FormData !== "undefined" && options.body instanceof FormData;
    const headers: Record<string, string> = {
      ...(options.body !== undefined && !isFormData ? { "Content-Type": "application/json" } : {}),
      ...(options.headers as Record<string, string>),
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const config: RequestInit = { ...options, headers };

    try {
      if (config.signal?.aborted) {
        throw config.signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
      }
      const response = await this.fetchWithTokenRefresh(url, endpoint, config);

      if (response.status === 204) {
        if (!response.ok) {
          throw new VayadaApiErrorResponse(response.status, { detail: "No Content" });
        }
        return undefined as T;
      }

      const contentType = response.headers.get("content-type");
      const text = await response.text();
      const data: unknown =
        contentType && contentType.includes("application/json")
          ? text
            ? JSON.parse(text)
            : null
          : text || null;

      if (!response.ok) {
        throw new VayadaApiErrorResponse(
          response.status,
          data && typeof data === "object"
            ? (data as VayadaApiError)
            : {
                detail: typeof data === "string" && data ? data : `API Error: ${response.status}`,
              },
        );
      }

      return data as T;
    } catch (error) {
      if (error instanceof VayadaApiErrorResponse) throw error;
      // A successful response whose JSON body is empty or broken resolves to undefined.
      if (error instanceof SyntaxError && error.message.includes("JSON")) return undefined as T;
      if (!wasRequestAborted(error, config.signal)) console.error("API request failed:", error);
      throw error;
    }
  }

  async get<T>(endpoint: string, options?: RequestInit): Promise<T> {
    return this.request<T>(endpoint, { ...options, method: "GET" });
  }

  async post<T>(endpoint: string, data?: unknown, options?: RequestInit): Promise<T> {
    return this.request<T>(endpoint, { ...options, method: "POST", body: JSON.stringify(data) });
  }
}
