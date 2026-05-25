/**
 * Authentication service for the affiliate dashboard
 * Uses the booking engine auth backend (port 8001)
 */

import { ApiClient } from "@/services/api/client";
import { clearAuthData, getUserName, getUserType, isLoggedInHint, storeUser } from "./storage";

const AUTH_API_URL = process.env.NEXT_PUBLIC_AUTH_API_URL || "https://api.booking.localhost";

const authClient = new ApiClient(AUTH_API_URL);

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  id: string;
  email: string;
  name: string;
  type: string;
  status: string;
  access_token: string;
  token_type: string;
  expires_in: number;
  message: string;
}

export interface ResetPasswordRequest {
  token: string;
  new_password: string;
}

export const authService = {
  login: async (data: LoginRequest): Promise<LoginResponse> => {
    // Server sets the httpOnly access_token cookie on this response —
    // we don't read or store the token here. Body is just used for
    // user display data.
    const response = await authClient.post<LoginResponse>("/auth/login", data);

    if (response.type !== "affiliate") {
      throw new Error("Access denied. Affiliate account required.");
    }

    storeUser({
      id: response.id,
      email: response.email,
      name: response.name,
      type: response.type,
      status: response.status,
    });

    return response;
  },

  setPassword: async (data: ResetPasswordRequest): Promise<void> => {
    await authClient.post("/auth/reset-password", data);
  },

  logout: async (): Promise<void> => {
    // Best-effort: clear the server-side cookie. Even if this fails
    // (network blip, server down), local state still gets wiped and
    // the user is bounced to /login.
    try {
      await authClient.post("/auth/logout");
    } catch {
      // ignore
    }
    clearAuthData();
    if (typeof window !== "undefined") {
      window.location.href = "/login";
    }
  },

  isLoggedIn: isLoggedInHint,

  isAffiliate: (): boolean => getUserType() === "affiliate",

  getUserName,

  getUserInitials: (): string => {
    const name = getUserName();
    if (!name) return "?";
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return name.substring(0, 2).toUpperCase();
  },
};
