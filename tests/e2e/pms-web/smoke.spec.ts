import { expect, test } from "@playwright/test";

test.describe("pms-web smoke", () => {
  test("login page redirects to hosted auth", async ({ request }) => {
    const response = await request.get("/login", { maxRedirects: 0 });

    expect(response.status()).toBe(307);

    const hostedLoginUrl = new URL(response.headers().location ?? "");
    expect(hostedLoginUrl.pathname).toBe("/auth/workos/login");
    expect(hostedLoginUrl.searchParams.get("surface")).toBe("pms-web");

    const returnTo = new URL(hostedLoginUrl.searchParams.get("return_to") ?? "");
    expect(returnTo.pathname).toBe("/login");
    expect(returnTo.searchParams.get("auth")).toBe("callback");
  });
});
