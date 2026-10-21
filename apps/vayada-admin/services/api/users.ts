/**
 * Users API service for admin
 */

import { apiClient } from "./client";
import type { CreateUserRequest, User, UserDetailResponse } from "@/lib/types";

export interface UsersListResponse {
  users: User[];
  total: number;
}

export interface IdentityCommandResponse {
  userId: string;
  status: "accepted" | "idempotent_replay";
  commands: Array<{
    commandType: string;
    commandId: string;
    idempotencyKey: string;
    status: "accepted" | "idempotent_replay";
  }>;
}

/**
 * Transform snake_case to camelCase for nested objects
 */
function transformSnakeToCamel(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => transformSnakeToCamel(item));
  }
  if (typeof obj !== "object") return obj;

  const transformed: any = {};
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    transformed[camelKey] = transformSnakeToCamel(value);
  }
  return transformed;
}

export const usersService = {
  /**
   * Get all users (with optional filters and pagination)
   */
  getAllUsers: async (params?: {
    type?: User["type"];
    status?: "pending" | "verified" | "rejected" | "suspended";
    search?: string;
    /** Only accounts that platform property provisioning accepts and that have no hotel yet. */
    provisionable?: boolean;
    page?: number;
    page_size?: number;
  }): Promise<UsersListResponse> => {
    const queryParams = new URLSearchParams();

    // Add query parameters if provided
    if (params?.page) queryParams.append("page", params.page.toString());
    if (params?.page_size) queryParams.append("page_size", params.page_size.toString());
    if (params?.type) queryParams.append("type", params.type);
    if (params?.status) queryParams.append("status", params.status);
    if (params?.search) queryParams.append("search", params.search);
    if (params?.provisionable) queryParams.append("provisionable", "true");

    const queryString = queryParams.toString();
    const endpoint = `/api/identity/admin/users${queryString ? `?${queryString}` : ""}`;

    return apiClient.get<UsersListResponse>(endpoint);
  },

  /**
   * Get the identity user by ID
   */
  getUserById: async (userId: string): Promise<UserDetailResponse> => {
    const response = await apiClient.get<any>(`/api/identity/admin/users/${userId}`);
    return transformSnakeToCamel(response) as UserDetailResponse;
  },

  /**
   * Create a new identity user.
   */
  createUser: async (data: CreateUserRequest): Promise<User> => {
    const response = await apiClient.post<IdentityCommandResponse>("/api/identity/admin/users", {
      email: data.email,
      name: data.name,
      type: data.type,
      status: data.status,
      emailVerified: data.emailVerified,
    });
    return {
      id: response.userId,
      email: data.email,
      name: data.name,
      type: data.type,
      status: data.status ?? "pending",
      email_verified: data.emailVerified,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  },

  /**
   * Update user account fields (status, emailVerified, email, name, etc.)
   */
  updateUser: async (
    userId: string,
    data: {
      status?: "pending" | "verified" | "rejected" | "suspended";
      emailVerified?: boolean;
      email?: string;
      name?: string;
    },
  ): Promise<any> => {
    const response = await apiClient.patch<any>(`/api/identity/admin/users/${userId}`, data);
    return transformSnakeToCamel(response);
  },

  /**
   * Soft-delete an identity user through the identity lifecycle command bus.
   */
  deleteUser: async (userId: string): Promise<{ message: string; deleted_user: User }> => {
    const response = await apiClient.delete<IdentityCommandResponse>(
      `/api/identity/admin/users/${userId}`,
    );
    return {
      message: "Identity user deletion command accepted.",
      deleted_user: {
        id: response.userId,
        email: "",
        name: "",
        type: "admin",
        status: "suspended",
        created_at: "",
        updated_at: "",
      },
    };
  },

  setPlatformAccess: async (userId: string, enabled: boolean): Promise<IdentityCommandResponse> => {
    return apiClient.put<IdentityCommandResponse>(
      `/api/identity/admin/users/${userId}/platform-access`,
      { enabled },
    );
  },
};
