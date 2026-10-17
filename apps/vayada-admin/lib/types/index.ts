/**
 * Type definitions for the admin frontend
 */

export interface User {
  id: string;
  email: string;
  name: string;
  /** "creator" rows exist until the Marketplace data is deleted (VAY-2259 step 5). */
  type: "hotel" | "creator" | "admin";
  status: "pending" | "verified" | "rejected" | "suspended";
  avatar?: string | null;
  email_verified?: boolean;
  created_at: string;
  updated_at: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  id?: string;
  email?: string;
  name?: string;
  type?: string;
  status?: string;
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  is_superadmin?: boolean;
  message: string;
  requires_totp?: boolean;
  totp_session?: string;
}

export interface CreateUserRequest {
  email: string;
  password: string;
  name: string;
  type: "hotel";
  status?: "pending" | "verified" | "rejected" | "suspended";
  emailVerified?: boolean;
  avatar?: string;
}

export interface UpdateUserRequest {
  name?: string;
  email?: string;
  status?: "pending" | "verified" | "rejected" | "suspended";
}

// API Response Types for User Detail Endpoint
export interface UserDetailResponse {
  id: string;
  email: string;
  name: string;
  type: "creator" | "hotel" | "admin";
  status: "pending" | "verified" | "rejected" | "suspended";
  emailVerified: boolean;
  avatar: string | null;
  createdAt: string;
  updatedAt: string;
}
