import { expect, test } from "@playwright/test";
import { watchPageHealth } from "../support/pageHealth";

const routes = [
  {
    path: "/",
    heading: /Hotels are losing control over their demand/i,
  },
  {
    path: "/booking-engine",
    heading: /The booking engine built for independent hospitality/i,
  },
  {
    path: "/pms",
    heading: /The PMS built for modern independent hospitality/i,
  },
  {
    path: "/pricing",
    heading: /Pricing built for direct bookings/i,
  },
  {
    path: "/contact",
    heading: /Get in touch with vayada/i,
  },
];

test.describe("landing smoke", () => {
  // VAY-2213: the booking sites' "Privacy notice" link lands on this section, below the fixed
  // navigation.
  test("/privacy#booking-guests opens the booking guests section", async ({ page }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);

    await page.goto("/privacy#booking-guests");

    const heading = page.getByRole("heading", { name: "9. Guests of Hotel Booking Sites" });
    await expect(heading).toBeInViewport();
    const nav = (await page.locator("nav").first().boundingBox())!;
    await expect
      .poll(async () => (await heading.boundingBox())!.y)
      .toBeGreaterThanOrEqual(nav.y + nav.height);

    await assertHealthy();
  });

  // VAY-2286: the effective date must be a real date; a "[go-live date]" placeholder waiting for
  // the release day must never go live.
  test("/privacy shows a real effective date", async ({ page }) => {
    await page.goto("/privacy");

    const effective = page.locator("p", {
      has: page.getByText("Effective Date:", { exact: true }),
    });
    await expect(effective).toHaveText(
      /^Effective Date: (January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}$/,
    );
  });

  // VAY-2246: hotels accept this DPA version at sign-up; the Terms and the privacy notice link to it.
  test("/terms/dpa shows the data processing agreement", async ({ page }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);

    await page.goto("/terms/dpa");

    await expect(
      page.getByRole("heading", {
        name: "Data Processing Agreement (Annex to the Hotel Terms)",
        level: 1,
      }),
    ).toBeVisible();
    await expect(
      page.locator("p", { has: page.getByText("Version:", { exact: true }) }),
    ).toHaveText("Version: October 24, 2026");
    await expect(page.getByRole("main").getByRole("heading", { level: 2 })).toHaveText([
      "1. Parties and subject matter",
      "2. Nature, purpose and duration",
      "3. Data and data subjects",
      "4. vayada's obligations",
      "5. Sub-processors",
      "6. Transfers outside the EU",
      "7. Annex 1: security measures",
      "8. Guest requests and data breaches",
      "9. When the Hotel leaves",
      "10. Audits and information",
    ]);
    await expect(page.getByRole("table")).toHaveCount(3);

    await assertHealthy();
  });

  for (const [path, linkName] of [
    ["/terms", "Data Processing Agreement"],
    ["/privacy", "data processing agreement"],
  ] as const) {
    test(`${path} links to the data processing agreement`, async ({ page }) => {
      await page.goto(path);

      await expect(page.getByRole("link", { name: linkName, exact: true })).toHaveAttribute(
        "href",
        "/terms/dpa",
      );
    });
  }

  // VAY-2246: JSX text holding &apos; or &quot; loses its leading space after a tag, which glued
  // bold lead-ins to the next word ("Card Refunds:When"). The space now sits inside <strong>.
  for (const path of ["/terms", "/privacy", "/terms/dpa"]) {
    test(`${path} keeps a space after every bold lead-in`, async ({ page }) => {
      await page.goto(path);

      const glued = await page.locator("main").evaluate((main) =>
        Array.from(main.querySelectorAll("strong"))
          .filter((strong) => {
            const next = strong.nextSibling?.textContent ?? "";
            return !/\s$/.test(strong.textContent ?? "") && /^[A-Za-z0-9(]/.test(next);
          })
          .map((strong) => `${strong.textContent}${strong.nextSibling?.textContent?.slice(0, 20)}`),
      );
      expect(glued).toEqual([]);
    });
  }

  for (const route of routes) {
    test(`${route.path} renders the public shell`, async ({ page }, testInfo) => {
      const assertHealthy = watchPageHealth(page, testInfo);

      await page.goto(route.path);

      await expect(page.getByRole("heading", { name: route.heading, level: 1 })).toBeVisible();
      await expect(page.getByRole("navigation")).toContainText(/vayada/i);
      await expect(page.locator("footer")).toContainText(/vayada/i);

      await assertHealthy();
    });
  }
});
