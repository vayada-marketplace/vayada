import { authApi, authStorage } from "./api/client";

interface LoginResponse {
  id: string;
  email: string;
  name: string;
  type: string;
  status: string;
  access_token: string;
  expires_in: number;
  is_superadmin?: boolean;
}

export const authService = {
  async login(email: string, password: string) {
    const response = await authApi.post<LoginResponse>("/auth/login", { email, password });
    if (typeof window !== "undefined") {
      localStorage.setItem("access_token", response.access_token);
      localStorage.setItem("token_expires_at", String(Date.now() + response.expires_in * 1000));
      localStorage.setItem("isLoggedIn", "true");
      localStorage.setItem("userId", response.id);
      localStorage.setItem("userEmail", response.email);
      localStorage.setItem("userName", response.name);
      localStorage.setItem("userType", response.type);
      localStorage.setItem("userStatus", response.status);
      localStorage.setItem("user", JSON.stringify(response));
    }
    return response;
  },
  logout() {
    authStorage.clearAuthData();
    if (typeof window !== "undefined") {
      window.location.href = "/login";
    }
  },
  isLoggedIn() {
    return authStorage.getToken() !== null;
  },
};
