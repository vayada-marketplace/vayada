const AUTH_BASE_URL = process.env.NEXT_PUBLIC_AUTH_API_URL || "https://api.booking.localhost";
const PMS_BASE_URL = process.env.NEXT_PUBLIC_PMS_API_URL || "https://api.pms.localhost";

const TOKEN_KEY = "access_token";
const EXPIRES_AT_KEY = "token_expires_at";

export class ApiErrorResponse extends Error {
  status: number;
  data: unknown;

  constructor(status: number, data: unknown) {
    const detail =
      data && typeof data === "object" && "detail" in data
        ? (data as { detail?: unknown }).detail
        : undefined;
    super(typeof detail === "string" ? detail : `API Error: ${status}`);
    this.name = "ApiErrorResponse";
    this.status = status;
    this.data = data;
  }
}

function clearAuthData() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(EXPIRES_AT_KEY);
  localStorage.removeItem("isLoggedIn");
  localStorage.removeItem("user");
  localStorage.removeItem("userId");
  localStorage.removeItem("userEmail");
  localStorage.removeItem("userName");
  localStorage.removeItem("userType");
  localStorage.removeItem("userStatus");
}

function getToken() {
  if (typeof window === "undefined") return null;
  const token = localStorage.getItem(TOKEN_KEY);
  const expiresAt = localStorage.getItem(EXPIRES_AT_KEY);
  if (!token || !expiresAt) return null;
  if (Date.now() >= Number(expiresAt)) {
    clearAuthData();
    return null;
  }
  return token;
}

export class ApiClient {
  constructor(private baseURL: string) {}

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string> | undefined),
    };
    const token = getToken();
    if (token && !endpoint.startsWith("/auth/")) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(`${this.baseURL}${endpoint}`, {
      ...options,
      headers,
    });
    const contentType = response.headers.get("content-type");
    const data = contentType?.includes("application/json")
      ? await response.json()
      : await response.text();

    if (!response.ok) {
      if (response.status === 401 && typeof window !== "undefined") {
        clearAuthData();
        window.location.href = "/login";
      }
      throw new ApiErrorResponse(response.status, data);
    }
    return data as T;
  }

  get<T>(endpoint: string) {
    return this.request<T>(endpoint, { method: "GET" });
  }

  post<T>(endpoint: string, data?: unknown) {
    return this.request<T>(endpoint, { method: "POST", body: JSON.stringify(data) });
  }

  patch<T>(endpoint: string, data?: unknown) {
    return this.request<T>(endpoint, { method: "PATCH", body: JSON.stringify(data) });
  }
}

export const authApi = new ApiClient(AUTH_BASE_URL);
export const pmsApi = new ApiClient(PMS_BASE_URL);
export const authStorage = { clearAuthData, getToken };
