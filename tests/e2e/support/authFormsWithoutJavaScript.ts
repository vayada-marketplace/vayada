import { expect, type Page } from "@playwright/test";

// Before a page hydrates, a click submits the plain HTML form, which is what these checks do with JavaScript off.
// A GET would put the email and password in the URL, the browser history and request logs (VAY-2271).

/** Every form the server renders on the page submits with POST. */
export async function expectEveryFormPosts(page: Page, path: string) {
  await page.goto(path);
  const methods = await page
    .locator("form")
    .evaluateAll((forms) => forms.map((form) => (form as HTMLFormElement).method));
  expect(
    methods.filter((method) => method !== "post"),
    `${path} forms: ${methods}`,
  ).toEqual([]);
}

/** Signing in before the page is interactive posts the form and keeps the email and password out of the URL. */
export async function expectSignInKeepsCredentialsOutOfTheUrl(page: Page, path = "/login") {
  const password = "kept-out-of-the-url";
  await page.goto(path);
  await page.getByLabel("Email address", { exact: true }).fill("owner@example.com");
  await page.getByLabel("Password", { exact: true }).fill(password);
  const [request] = await Promise.all([
    page.waitForRequest(
      (request) => request.isNavigationRequest() && request.frame() === page.mainFrame(),
    ),
    page.getByRole("button", { name: "Sign In", exact: true }).click(),
  ]);
  expect(request.method()).toBe("POST");
  const url = new URL(request.url());
  expect(url.searchParams.has("password")).toBe(false);
  expect(url.searchParams.has("email")).toBe(false);
  expect(request.url()).not.toContain(password);
  expect((await request.response())?.status() ?? 0).toBeLessThan(500);
  expect(page.url()).not.toContain(password);
}
