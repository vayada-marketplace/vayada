import { expect, test } from "@playwright/test";
import {
  authRequests,
  authSession,
  firstPartyAuthSurfaces,
  mockFirstPartyAuth,
  sessionCookieName,
} from "../support/firstPartyAuth";

const marketplace = firstPartyAuthSurfaces.find(({ key }) => key === "marketplace")!;

test("Marketplace signup reaches hotel onboarding without csrf_rejected", async ({ page }) => {
  const guestSession = {
    accessToken: "access-marketplace-guest",
    csrfToken: "csrf-marketplace",
    user: {
      email: "marketplace-signup@example.test",
      id: "user-marketplace-signup",
      status: "active",
    },
  };
  const records = await mockFirstPartyAuth(page, marketplace, async (route, record) => {
    const pathname = new URL(record.url).pathname;
    if (pathname === "/auth/password/signup") {
      await route.fulfill({
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": `${sessionCookieName(marketplace)}=sealed-marketplace; Path=/auth; HttpOnly; SameSite=Lax`,
        },
        json: guestSession,
      });
      return true;
    }
    if (pathname === "/auth/onboarding") {
      const session = authSession(marketplace, "hotel");
      await route.fulfill({
        status: 200,
        json: {
          ...session,
          user: { ...session.user, email: "marketplace-signup@example.test" },
        },
      });
      return true;
    }
    return false;
  });
  await page.goto(`${marketplace.baseURL}/signup`);
  await page.getByLabel(/email address/i).fill("marketplace-signup@example.test");
  await page.getByLabel(/^password$/i).fill("Regression123!");
  await page.getByRole("button", { name: /create account/i }).click();

  // VAY-2260: the creator Marketplace is closed; sign-up offers only the hotel path.
  await expect(page.getByRole("heading", { name: "Welcome to vayada", exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: /i’m a creator/i })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: /i manage a hotel/i })).toBeChecked();
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  await expect.poll(() => authRequests(records, "/auth/onboarding").length).toBe(1);
  const onboarding = authRequests(records, "/auth/onboarding")[0]!;
  expect(onboarding.body).toEqual({ surface: "marketplace-web", type: "hotel" });
  expect(onboarding.csrf).toBe("csrf-marketplace");
  expect(onboarding.cookie).toContain(`${sessionCookieName(marketplace)}=sealed-marketplace`);
  await expect(page.getByText("csrf_rejected", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Email address")).toHaveValue("marketplace-signup@example.test");
  await expect(page.getByRole("button", { name: "Continue to hotel setup" })).toBeVisible();
  for (const request of records) expect(new URL(request.url).origin).toBe(marketplace.baseURL);
});

for (const flow of ["login", "signup"] as const) {
  test(`Marketplace Google ${flow} keeps OAuth state on the app-local callback`, async ({
    page,
  }) => {
    const state = `state-${flow}`;
    const finalPath = flow === "login" ? "/handoff" : "/onboarding";
    let returnTo = "";
    let callbackCookie = "";
    let callbackOrigin = "";
    let oauthStartOrigin = "";
    const records = await mockFirstPartyAuth(page, marketplace, async (route, record) => {
      const url = new URL(record.url);
      if (url.pathname === "/auth/oauth/google/start") {
        expect(url.searchParams.get("flow")).toBe(flow);
        expect(url.searchParams.get("surface")).toBe("marketplace-web");
        oauthStartOrigin = url.origin;
        returnTo = url.searchParams.get("return_to") || finalPath;
        const callbackURL = new URL("/auth/oauth/google/callback", url.origin);
        callbackURL.searchParams.set("code", "sandbox-code");
        callbackURL.searchParams.set("state", state);
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          headers: {
            "set-cookie": `vayada_fp_oauth_state=${state}; Path=/auth/oauth; HttpOnly; SameSite=Lax`,
          },
          body: `<!doctype html><script>window.location.replace(${JSON.stringify(callbackURL.toString())})</script>`,
        });
        return true;
      }
      return false;
    });
    await page.route(
      (url) => {
        return url.origin === marketplace.baseURL && url.pathname === "/auth/oauth/google/callback";
      },
      async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        callbackOrigin = url.origin;
        callbackCookie = request.headers().cookie ?? "";
        expect(url.searchParams.get("state")).toBe(state);
        await route.fulfill({
          status: 302,
          headers: {
            location: returnTo,
            "set-cookie": `${sessionCookieName(marketplace)}=sealed-google-${flow}; Path=/auth; HttpOnly; SameSite=Lax`,
          },
        });
      },
    );
    const entryURL = new URL(flow === "login" ? "/login" : "/signup", marketplace.baseURL);
    if (flow === "login") entryURL.searchParams.set("returnTo", finalPath);
    await page.goto(entryURL.toString());
    const landing = page.waitForURL((url) => {
      const expected = new URL(returnTo || finalPath, marketplace.baseURL);
      return url.toString() === expected.toString();
    });
    await page.getByRole("button", { name: /continue with google/i }).click();
    await landing;

    await expect.poll(() => callbackCookie).toContain(`vayada_fp_oauth_state=${state}`);
    expect(oauthStartOrigin).toBe(marketplace.baseURL);
    expect(callbackOrigin).toBe(marketplace.baseURL);
    const callbackReturnURL = new URL(returnTo, marketplace.baseURL);
    expect(callbackReturnURL.origin).toBe(marketplace.baseURL);
    expect(callbackReturnURL.searchParams.get("returnTo") ?? callbackReturnURL.pathname).toBe(
      finalPath,
    );
    await expect
      .poll(() => authRequests(records, "/auth/session").length)
      .toBeGreaterThanOrEqual(1);
    const sessionRequest = authRequests(records, "/auth/session").find((request) =>
      request.cookie?.includes(`${sessionCookieName(marketplace)}=sealed-google-${flow}`),
    );
    expect(sessionRequest).toBeDefined();
    expect(new URL(sessionRequest!.url).origin).toBe(marketplace.baseURL);
    await expect(page.getByText("missing_session", { exact: true })).toHaveCount(0);
  });
}


