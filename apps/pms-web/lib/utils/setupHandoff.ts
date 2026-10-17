import {
  BrowserAuthHandoffError,
  createBrowserAuthHandoff,
  crossAppReauthenticationUrl,
  isSafeRelativeReturnTo,
} from "@vayada/product-onboarding";

// Booking Admin hosts the shared hotel setup wizard (VAY-2261). Sessions are host-only cookies,
// so the PMS never navigates there directly: it hands the session over with a one-time code
// (VAY-2266), or sends the user through Booking Admin's login with the setup path preserved.
export const BOOKING_ADMIN_URL =
  process.env.NEXT_PUBLIC_BOOKING_ADMIN_URL || "https://admin.booking.vayada.com";

export type SharedHotelSetupHandoff =
  | { kind: "handoff"; destination: string }
  | { kind: "reauthenticate"; destination: string }
  | { kind: "retryable" };

/**
 * The relative setup path for a guard decision or alias target: either a safe relative path, or
 * an absolute URL on the Booking Admin origin (as the setup guard builds). Anything else is null.
 */
export function sharedHotelSetupTargetPath(
  pathOrUrl: string,
  baseUrl: string = BOOKING_ADMIN_URL,
): string | null {
  if (isSafeRelativeReturnTo(pathOrUrl)) return pathOrUrl;
  let url: URL;
  let base: URL;
  try {
    url = new URL(pathOrUrl);
    base = new URL(baseUrl);
  } catch {
    return null;
  }
  if (url.origin !== base.origin || url.hash) return null;
  const path = `${url.pathname}${url.search}`;
  return isSafeRelativeReturnTo(path) ? path : null;
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
      });
      return { kind: "handoff", destination };
    } catch (error) {
      if (error instanceof BrowserAuthHandoffError && error.retryable) return { kind: "retryable" };
      // A terminal failure (expired session, handoff disabled) means signing in at the target.
    }
  }
  try {
    return {
      kind: "reauthenticate",
      destination: crossAppReauthenticationUrl(baseUrl, input.targetPath),
    };
  } catch {
    return { kind: "retryable" };
  }
}
