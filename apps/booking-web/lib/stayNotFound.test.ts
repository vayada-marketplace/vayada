import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { STAY_NOT_FOUND_WORDS, stayNotFoundPage } from "./stayNotFound";

// VAY-2462: the middleware's 404 for a stay's pages an address doesn't show.
describe("stayNotFoundPage", () => {
  it("says what the page's own card says, in every language the app has", () => {
    const folder = fileURLToPath(new URL("../messages/", import.meta.url));
    const locales = readdirSync(folder)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.replace(/\.json$/, ""));
    expect(Object.keys(STAY_NOT_FOUND_WORDS).sort()).toEqual(locales.sort());
    for (const locale of locales) {
      const { error } = JSON.parse(readFileSync(`${folder}${locale}.json`, "utf8"));
      expect(STAY_NOT_FOUND_WORDS[locale], locale).toEqual({
        notOnline: error.notOnline,
        checkBackLater: error.checkBackLater,
      });
    }
  });

  it("answers 404, not to be indexed or kept, in the address's language", async () => {
    const response = stayNotFoundPage("fr");
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    const html = await response.text();
    expect(html).toContain('<html lang="fr">');
    expect(html).toContain("Cette page de réservation n&#39;est pas en ligne pour le moment");
    expect(await stayNotFoundPage("nl").text()).toContain('<html lang="en">');
  });
});
