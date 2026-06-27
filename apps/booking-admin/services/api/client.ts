/**
 * API client configuration
 */

import {
  clearAuthData,
  getAuthBearerToken,
  getLegacyAdminBearerToken,
  isCompatibilityTokenEnabled,
} from "../auth/sessionStore";
import { ensureBookingCompatibilityToken } from "../auth/compatibilityToken";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "https://api.booking.localhost";
const OMIT_HOTEL_CONTEXT_HEADER = "X-Vayada-Omit-Hotel-Context";

export function isNextApiTarget(
  apiBaseUrl = process.env.NEXT_PUBLIC_API_URL || API_BASE_URL,
): boolean {
  return apiBaseUrl.includes("next-api.vayada.com");
}

export const omitHotelContext: RequestInit = {
  headers: { [OMIT_HOTEL_CONTEXT_HEADER]: "true" },
};

export interface ApiError {
  detail:
    | string
    | Array<{
        loc: (string | number)[];
        msg: string;
        type: string;
      }>;
}

export class ApiErrorResponse extends Error {
  status: number;
  data: ApiError;

  constructor(status: number, data: ApiError) {
    const message =
      typeof data.detail === "string"
        ? data.detail
        : Array.isArray(data.detail)
          ? data.detail.map((e) => e.msg).join(", ")
          : `API Error: ${status}`;
    super(message);
    this.name = "ApiErrorResponse";
    this.status = status;
    this.data = data;
  }
}

export class ApiClient {
  private baseURL: string;

  constructor(baseURL: string = API_BASE_URL) {
    this.baseURL = baseURL;
  }

  /**
   * Handle 401 errors (token expired/invalid)
   */
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

    // Get token for authenticated requests (skip for public auth endpoints)
    const publicAuthEndpoints = [
      "/auth/register",
      "/auth/login",
      "/auth/forgot-password",
      "/auth/reset-password",
      "/auth/validate-token",
      "/auth/verify-email-change",
    ];
    const legacyAdminRoute = endpoint.startsWith("/admin/") && !isNextApiTarget(this.baseURL);
    if (
      !publicAuthEndpoints.includes(endpoint) &&
      legacyAdminRoute &&
      isCompatibilityTokenEnabled()
    ) {
      await ensureBookingCompatibilityToken();
    }
    const token = publicAuthEndpoints.includes(endpoint)
      ? null
      : legacyAdminRoute
        ? getLegacyAdminBearerToken()
        : getAuthBearerToken();

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string>),
    };
    const omitHotelContextHeader = headers[OMIT_HOTEL_CONTEXT_HEADER] === "true";
    delete headers[OMIT_HOTEL_CONTEXT_HEADER];

    // Add Authorization header if token exists
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    // Legacy `/admin/*` compatibility routes still use the hotel context
    // header. Target routes carry the resource id in the path.
    const hotelId = typeof window !== "undefined" ? localStorage.getItem("selectedHotelId") : null;
    if (hotelId && endpoint.startsWith("/admin/") && !omitHotelContextHeader) {
      headers["X-Hotel-Id"] = hotelId;
    }

    const config: RequestInit = {
      ...options,
      headers,
    };

    try {
      const response = await fetch(url, config);

      // Handle 204 No Content responses (no body to parse)
      if (response.status === 204) {
        if (!response.ok) {
          throw new ApiErrorResponse(response.status, { detail: "No Content" });
        }
        return undefined as T;
      }

      // Check if response has content to parse
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

        // Handle 401 errors (token expired/invalid)
        if (response.status === 401 && !endpoint.startsWith("/auth/")) {
          this.handleUnauthorized(error);
        }

        throw error;
      }

      return data as T;
    } catch (error) {
      if (error instanceof ApiErrorResponse) {
        throw error;
      }
      if (error instanceof SyntaxError && error.message.includes("JSON")) {
        return undefined as T;
      }
      console.error("API request failed:", error);
      throw error;
    }
  }

  async get<T>(endpoint: string, options?: RequestInit): Promise<T> {
    return this.request<T>(endpoint, { ...options, method: "GET", cache: "no-store" });
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
