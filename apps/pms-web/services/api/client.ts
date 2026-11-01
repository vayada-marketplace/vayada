/**
 * API client configuration
 */

import {
  recoverUnauthorizedResponse,
  redirectToOrganizationSelection,
  type ApiSessionRecoveryHandlers,
} from "@vayada/product-onboarding/apiSessionRecovery";
import {
  clearAuthData,
  getAuthBearerToken,
  isAuthOrganizationSelectionResponse,
  isAuthKitLoginEnabled,
} from "../auth/sessionStore";

const API_BASE_URL = process.env.NEXT_PUBLIC_AUTH_API_URL || "https://api.booking.localhost";

// VAY-2423: a full navigation aborts the page's reads as it goes ("TypeError: Failed to fetch"). The page is going
// away, so that isn't a failure to report, and the page's own catches would log the same read again: once the page
// is being left, such a read never settles instead. A page restored from the back/forward cache reads as before.
let pageLeaving = false;
export function followPageLeaving(target: Pick<EventTarget, "addEventListener">) {
  target.addEventListener("pagehide", () => {
    pageLeaving = true;
  });
  target.addEventListener("pageshow", () => {
    pageLeaving = false;
  });
}
if (typeof window !== "undefined") followPageLeaving(window);
const OMIT_HOTEL_CONTEXT_HEADER = "X-Vayada-Omit-Hotel-Context";

const defaultSessionRecoveryHandlers: ApiSessionRecoveryHandlers = {
  async refresh() {
    const { authService } = await import("../auth");
    const response = await authService.refreshSession();
    return isAuthOrganizationSelectionResponse(response)
      ? { status: "organization_selection_required" }
      : { status: "session_refreshed" };
  },
  onOrganizationSelectionRequired: redirectToOrganizationSelection,
  async signOut() {
    const { authService } = await import("../auth");
    await authService.logout();
  },
};

export function isNextApiTarget(
  apiBaseUrl = process.env.NEXT_PUBLIC_AUTH_API_URL || API_BASE_URL,
): boolean {
  try {
    return new URL(apiBaseUrl).hostname === "next-api.vayada.com";
  } catch {
    return false;
  }
}

export const omitHotelContext: RequestInit = {
  headers: { [OMIT_HOTEL_CONTEXT_HEADER]: "true" },
};

export interface ApiError {
  detail?:
    | string
    | Array<{
        loc: (string | number)[];
        msg: string;
        type: string;
      }>;
  message?: string;
  code?: string;
  category?: string;
  field?: string;
  stayPosition?: number;
}

export class ApiErrorResponse extends Error {
  status: number;
  data: ApiError;

  constructor(status: number, data: ApiError) {
    let message: string;
    if (typeof data.detail === "string") {
      message = data.detail;
    } else if (Array.isArray(data.detail)) {
      message = data.detail.map((e) => e.msg).join(", ");
    } else if (
      data.detail &&
      typeof data.detail === "object" &&
      typeof (data.detail as { message?: unknown }).message === "string"
    ) {
      message = (data.detail as { message: string }).message;
    } else if (typeof data.message === "string") {
      message = data.message;
    } else {
      message = `API Error: ${status}`;
    }
    super(message);
    this.name = "ApiErrorResponse";
    this.status = status;
    this.data = data;
  }
}

export class ApiClient {
  private baseURL: string;
  private sessionRecoveryHandlers: ApiSessionRecoveryHandlers | null;

  constructor(
    baseURL: string = API_BASE_URL,
    sessionRecoveryHandlers: ApiSessionRecoveryHandlers | null = defaultSessionRecoveryHandlers,
  ) {
    this.baseURL = baseURL;
    this.sessionRecoveryHandlers = sessionRecoveryHandlers;
  }

  private handleUnauthorized(error: ApiErrorResponse): void {
    clearAuthData();

    if (typeof window !== "undefined") {
      const errorMessage = (error.data.detail as string) || "";
      const isExpired = errorMessage.includes("expired") || errorMessage.includes("Expired");

      if (isExpired) {
        window.location.href = "/login?expired=true";
      } else {
        window.location.href = "/login";
      }
    }
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseURL}${endpoint}`;

    const token = !endpoint.startsWith("/auth/") ? getAuthBearerToken() : null;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string>),
    };
    delete headers[OMIT_HOTEL_CONTEXT_HEADER];

    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const config: RequestInit = {
      ...options,
      headers,
    };

    try {
      let response = await fetch(url, config);
      if (
        response.status === 401 &&
        !endpoint.startsWith("/auth/") &&
        isAuthKitLoginEnabled() &&
        this.sessionRecoveryHandlers
      ) {
        response = await recoverUnauthorizedResponse({
          response,
          failedToken: token,
          getToken: getAuthBearerToken,
          handlers: this.sessionRecoveryHandlers,
          retry: (refreshedToken) =>
            fetch(url, {
              ...config,
              headers: {
                ...headers,
                Authorization: `Bearer ${refreshedToken}`,
              },
            }),
        });
      }

      if (response.status === 204) {
        if (!response.ok) {
          throw new ApiErrorResponse(response.status, { detail: "No Content" });
        }
        return undefined as T;
      }

      const contentType = response.headers.get("content-type");
      const hasJsonContent = contentType && contentType.includes("application/json");

      let data: any;
      if (hasJsonContent) {
        const text = await response.text();
        data = text ? JSON.parse(text) : null;
      } else {
        const text = await response.text();
        data = text || null;
      }

      if (!response.ok) {
        const error = new ApiErrorResponse(response.status, data as ApiError);

        if (
          response.status === 401 &&
          !endpoint.startsWith("/auth/") &&
          (!isAuthKitLoginEnabled() || !this.sessionRecoveryHandlers)
        ) {
          this.handleUnauthorized(error);
        }

        throw error;
      }

      return data as T;
    } catch (error) {
      if (options.signal?.aborted || error instanceof ApiErrorResponse) {
        throw error;
      }
      if (error instanceof SyntaxError && error.message.includes("JSON")) {
        return undefined as T;
      }
      if (pageLeaving && error instanceof TypeError) return new Promise<T>(() => undefined);
      console.error("API request failed:", error);
      throw error;
    }
  }

  async get<T>(endpoint: string, options?: RequestInit): Promise<T> {
    return this.request<T>(endpoint, { ...options, method: "GET" });
  }

  async post<T>(endpoint: string, data?: unknown, options?: RequestInit): Promise<T> {
    return this.request<T>(endpoint, {
      ...options,
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async put<T>(endpoint: string, data?: unknown, options?: RequestInit): Promise<T> {
    return this.request<T>(endpoint, {
      ...options,
      method: "PUT",
      body: JSON.stringify(data),
    });
  }

  async patch<T>(endpoint: string, data?: unknown, options?: RequestInit): Promise<T> {
    return this.request<T>(endpoint, {
      ...options,
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  async delete<T>(endpoint: string, options?: RequestInit): Promise<T> {
    return this.request<T>(endpoint, { ...options, method: "DELETE" });
  }
}

export const apiClient = new ApiClient();
