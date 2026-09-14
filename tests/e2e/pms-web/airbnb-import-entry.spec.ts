import { expect, test } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
} from "../support/pmsWebMocks";
test.skip(process.env.E2E_PMS_AIRBNB_IMPORT !== "1", "Airbnb settings entry is opt-in");
test("room settings opens sign-in for the selected hotel's Airbnb import", async ({
  page,
  context,
}) => {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await context.route("https://marketplace.localhost:1382/login?**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<h1>Simulated Marketplace sign-in</h1>" }),
  );
  await page.goto("/rooms");
  const link = page.getByRole("link", { name: "Import rooms from Airbnb (opens in a new tab)" });
  await expect(link).toBeVisible();
  const href = new URL((await link.getAttribute("href"))!);
  expect(href.origin).toBe("https://marketplace.localhost:1382");
  expect(href.pathname).toBe("/login");
  expect(href.searchParams.get("returnTo")).toBe(`/setup/airbnb-connect/${PMS_WEB_PROPERTY_ID}`);
  const popupPromise = page.waitForEvent("popup");
  await link.click();
  const popup = await popupPromise;
  await expect(popup.getByRole("heading", { name: "Simulated Marketplace sign-in" })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/rooms");
  await popup.close();
});
