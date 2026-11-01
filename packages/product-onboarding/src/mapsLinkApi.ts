import type { SharedHotelSetupHttpClient } from "./sharedHotelSetupApi";

/** VAY-2444: the long Google Maps link a maps.app.goo.gl share link opens. The API follows the redirect, which a
 * browser can't read across origins. Null when the link can't be resolved, for any reason. */
export function createMapsLinkApi(client: Pick<SharedHotelSetupHttpClient, "post">) {
  return {
    async resolveShortLink(url: string): Promise<string | null> {
      try {
        const answer = await client.post<{ url?: unknown }>("/api/maps-links/resolve", { url });
        return typeof answer?.url === "string" ? answer.url : null;
      } catch {
        return null;
      }
    },
  };
}
export type MapsLinkApi = ReturnType<typeof createMapsLinkApi>;
