/**
 * Access control utilities for restricted features
 */

import type { UserType } from "@/lib/types";
import { STORAGE_KEYS } from "@/lib/constants";

/**
 * List of allowed emails for testing purposes (e.g., cofounder)
 * Add emails here to grant access even if user is not superadmin
 */
const ALLOWED_TEST_EMAILS: string[] = [
  // Add cofounder or other test emails here
  // Example: 'cofounder@example.com'
];

/**
 * Check if the current user has access to restricted features (marketplace, collaborations)
 *
 * Access is granted if:
 * - User has is_superadmin=true
 * - User email is in the ALLOWED_TEST_EMAILS list
 *
 * @returns true if user has access, false otherwise
 */
export function hasRestrictedFeatureAccess(): boolean {
  if (typeof window === "undefined") return false;

  const isSuperAdmin = localStorage.getItem(STORAGE_KEYS.IS_SUPERADMIN) === "true";
  const userEmail = localStorage.getItem(STORAGE_KEYS.USER_EMAIL);

  if (isSuperAdmin) {
    return true;
  }

  // Check if email is in allowed test emails list
  if (userEmail && ALLOWED_TEST_EMAILS.length > 0) {
    const normalizedEmail = userEmail.toLowerCase().trim();
    return ALLOWED_TEST_EMAILS.some((email) => email.toLowerCase().trim() === normalizedEmail);
  }

  return false;
}

/**
 * Get current user info from localStorage
 */
export function getCurrentUserInfo(): {
  userType: UserType | null;
  userEmail: string | null;
  userId: string | null;
} {
  if (typeof window === "undefined") {
    return {
      userType: null,
      userEmail: null,
      userId: null,
    };
  }

  return {
    userType: localStorage.getItem(STORAGE_KEYS.USER_TYPE) as UserType | null,
    userEmail: localStorage.getItem(STORAGE_KEYS.USER_EMAIL),
    userId: localStorage.getItem(STORAGE_KEYS.USER_ID),
  };
}
