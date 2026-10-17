import {
  BrowserAuthHandoffError,
  createBrowserAuthHandoff,
  crossAppReauthenticationUrl,
} from "@vayada/product-onboarding";
import { ApiErrorResponse } from "@/services/api/client";
import { AuthStateError } from "@/services/auth";

// Booking Admin hosts the shared hotel setup wizard (VAY-2261). Sessions are host-only cookies,
// so the PMS never navigates there directly: it hands the session over with a one-time code
// (VAY-2266), or sends the user through Booking Admin's login with the setup path preserved.
export const BOOKING_ADMIN_URL =
  process.env.NEXT_PUBLIC_BOOKING_ADMIN_URL || "https://admin.booking.vayada.com";

export type SharedHotelSetupHandoff =
  | { kind: "handoff"; destination: string }
  | { kind: "reauthenticate"; destination: string }
  | { kind: "retryable" };

/** A failed PMS session read is either a missing session or a temporary outage. */
export function classifyPmsSessionFailure(error: unknown): "signed_out" | "unavailable" {
  if (error instanceof AuthStateError) return "signed_out";
  if (error instanceof ApiErrorResponse && error.status < 500) return "signed_out";
  return "unavailable";
}

/** The PMS's own login, returning to the setup alias so the handoff runs after sign-in. */
export function pmsLoginUrlForSetup(aliasPath: string): string {
  return `/login?${new URLSearchParams({ returnTo: aliasPath }).toString()}`;
}

/**
 * Resolves where the browser must go to open `targetPath` in Booking Admin while staying signed
 * in: a one-time handoff destination when the PMS session can mint one, Booking Admin's login
 * with the path as returnTo when it cannot, or "retryable" when the exchange is temporarily down.
 */
export async function resolveSharedHotelSetupHandoff(input: {
  targetPath: string;
  csrfToken: string | null;
  baseUrl?: string;
  signal?: AbortSignal;
  create?: typeof createBrowserAuthHandoff;
}): Promise<SharedHotelSetupHandoff> {
  const baseUrl = input.baseUrl ?? BOOKING_ADMIN_URL;
  const create = input.create ?? createBrowserAuthHandoff;
  if (input.csrfToken) {
    try {
      const destination = await create({
        csrfToken: input.csrfToken,
        sourceSurface: "pms-web",
        targetPath: input.targetPath,
        targetSurface: "booking-admin",
        ...(input.signal
          ? { fetcher: (url, init) => fetch(url, { ...init, signal: input.signal }) }
          : {}),
      });
      return { kind: "handoff", destination };
    } catch (error) {
      if (!(error instanceof BrowserAuthHandoffError)) throw error;
      if (error.retryable) return { kind: "retryable" };
      // A terminal failure (expired session, handoff disabled) means signing in at the target.
    }
  }
  try {
    return {
      kind: "reauthenticate",
      destination: crossAppReauthenticationUrl(baseUrl, input.targetPath),
    };
  } catch (error) {
    console.error("Booking Admin origin is not configured for the setup handoff:", error);
    return { kind: "retryable" };
  }
}
