"use client";

import { useEffect } from "react";

export default function HandoffPage() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    // Auth data arrives in the URL hash so it never hits server logs.
    const hashParams = new URLSearchParams(window.location.hash.slice(1));
    const token = hashParams.get("token");
    const expiresAt = hashParams.get("expires_at");
    const userData = hashParams.get("user");
    const handoffHotelId = hashParams.get("hotel_id");

    // Optional `?redirect=...` query param tells us where to go after
    // auth. Used by the PMS header's "Add Property" button which
    // needs to land on /setup?mode=add instead of /dashboard.
    const queryParams = new URLSearchParams(window.location.search);
    const redirectParam = queryParams.get("redirect");
    // Only honor same-origin relative paths — never trust an arbitrary URL
    const safeRedirect =
      redirectParam && redirectParam.startsWith("/") && !redirectParam.startsWith("//")
        ? redirectParam
        : null;

    if (token && expiresAt) {
      localStorage.setItem("access_token", token);
      localStorage.setItem("token_expires_at", expiresAt);
      if (handoffHotelId) {
        localStorage.setItem("selectedHotelId", handoffHotelId);
      }
      if (userData) {
        try {
          const user = JSON.parse(decodeURIComponent(userData));
          localStorage.setItem("isLoggedIn", "true");
          localStorage.setItem("userId", user.id);
          localStorage.setItem("userEmail", user.email);
          localStorage.setItem("userName", user.name);
          localStorage.setItem("userType", user.type);
          localStorage.setItem("userStatus", user.status);
          localStorage.setItem("user", JSON.stringify(user));
        } catch {
          /* ignore */
        }
      }

      // Decide where to land based on how many hotels the user owns.
      // Precedence: explicit safeRedirect > dashboard (if handoffHotelId)
      // > setup (if 0 hotels) > choose-property (if 2+) > dashboard (1).
      // Note: we intentionally do NOT look at setup-status' field-level
      // completeness here — if the user has a hotel row, they belong in
      // the dashboard, even if some metadata (contact_phone, address)
      // is still empty. Blocking them over that would kick them to the
      // setup wizard on every login which is user-hostile.
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || "https://booking-api.vayada.com";
      (async () => {
        try {
          if (safeRedirect) {
            localStorage.setItem("setupComplete", "true");
            window.location.href = safeRedirect;
            return;
          }

          const listRes = await fetch(`${apiUrl}/admin/hotels`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          const hotels = listRes.ok ? await listRes.json() : [];
          const hasAnyHotel = Array.isArray(hotels) && hotels.length > 0;
          localStorage.setItem("setupComplete", hasAnyHotel ? "true" : "false");

          if (!hasAnyHotel) {
            window.location.href = "/setup";
            return;
          }

          // If the caller already told us which hotel to land on,
          // honor it and skip the choose-property step.
          if (handoffHotelId) {
            window.location.href = "/dashboard";
            return;
          }

          // Multi-hotel users get the picker so cross-domain handoff
          // doesn't silently drop them into an arbitrary dashboard.
          if (hotels.length > 1) {
            localStorage.removeItem("selectedHotelId");
            window.location.href = "/choose-property";
            return;
          }

          localStorage.setItem("selectedHotelId", hotels[0].id);
          window.location.href = "/dashboard";
        } catch {
          // If the list call fails, fall through to dashboard —
          // the dashboard will use its own fallback logic.
          localStorage.setItem("setupComplete", "true");
          window.location.href = safeRedirect || "/dashboard";
        }
      })();
    } else {
      window.location.href = "/login";
    }
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}
