import { expect, test, type Page } from "@playwright/test";
import { featureHubRetirementChecks } from "../support/featureHubRetirementChecks";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
} from "../support/pmsWebMocks";

async function setup(page: Page) {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await page.route("**/api/identity/staff/self-access", (route) =>
    route.fulfill({
      json: {
        membershipId: "pms-owner-membership",
        roleKey: "hotel_owner",
        permissions: ["pms.finance.read", "pms.finance.manage"],
      },
    }),
  );
}

featureHubRetirementChecks(PMS_WEB_PROPERTY_ID, setup);

test("Financials can be switched off during suspension without showing effective access", async ({
  page,
}) => {
  await setup(page);
  let configured = true;
  let suspended = true;
  const writes: boolean[] = [];
  let rejectOn!: () => void;
  const pendingOn = new Promise<void>((resolve) => {
    rejectOn = resolve;
  });
  let commitOn!: () => void;
  const pendingCommit = new Promise<void>((resolve) => {
    commitOn = resolve;
  });
  await page.route(
    new RegExp(`/api/pms/properties/${PMS_WEB_PROPERTY_ID}/module-activations(?:/financials)?$`),
    async (route) => {
      if (route.request().method() === "GET")
        return route.fulfill({
          json: {
            hotelId: PMS_WEB_PROPERTY_ID,
            canManage: true,
            supportedModules: ["financials"],
            activeModules: !suspended && configured ? ["financials"] : [],
            activations: [{ moduleId: "financials", isActive: configured }],
          },
        });
      const { isActive } = route.request().postDataJSON();
      writes.push(isActive);
      if (isActive && suspended) {
        await pendingOn;
        return route.fulfill({
          status: 409,
          json: { message: "The organization has suspended Financials." },
        });
      }
      if (isActive) await pendingCommit;
      configured = isActive;
      return route.fulfill({ json: { moduleId: "financials", isActive } });
    },
  );
  await page.goto("/settings/feature-hub");
  const toggle = page.getByRole("switch", { name: /Financials/ });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("listitem").filter({ hasText: /^Financials$/ })).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect.poll(() => writes).toEqual([false]);
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect.poll(() => writes).toEqual([false, true]);
  await expect(page.getByRole("listitem").filter({ hasText: /^Financials$/ })).toHaveCount(0);
  rejectOn();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.getByText("The organization has suspended Financials.")).toBeVisible();
  suspended = false;
  await toggle.click();
  await expect.poll(() => writes).toEqual([false, true, true]);
  const peer = await page.context().newPage();
  await setup(peer);
  let peerReads = 0;
  let releaseRead!: () => void;
  const delayedRead = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  await peer.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/module-activations`,
    async (route) => {
      peerReads++;
      await delayedRead;
      return route.fulfill({
        json: {
          hotelId: PMS_WEB_PROPERTY_ID,
          canManage: true,
          supportedModules: ["financials"],
          activeModules: [],
          activations: [{ moduleId: "financials", isActive: false }],
        },
      });
    },
  );
  await peer.goto("/settings/feature-hub");
  await expect.poll(() => peerReads).toBeGreaterThan(0);
  // An existing same-window reader binds the peer while its older GET remains pending.
  await peer.evaluate(
    (hotelId) =>
      window.dispatchEvent(
        new CustomEvent("vayada-feature-modules-changed", {
          detail: {
            hotelId,
            source: "read",
            canManage: true,
            supportedModuleIds: ["financials"],
            activeModuleIds: [],
            configuredModuleIds: [],
          },
        }),
      ),
    PMS_WEB_PROPERTY_ID,
  );
  await expect(peer.getByRole("switch", { name: /Financials/ })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  commitOn();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("listitem").filter({ hasText: /^Financials$/ })).toHaveCount(1);
  await expect(peer.getByRole("switch", { name: /Financials/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  const oldRead = peer.waitForResponse((response) =>
    response.url().endsWith("/module-activations"),
  );
  releaseRead();
  await oldRead;
  await expect(peer.getByRole("listitem").filter({ hasText: /^Financials$/ })).toHaveCount(1);
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await peer.close();
});
