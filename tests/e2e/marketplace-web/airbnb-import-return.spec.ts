import { expect, test } from "@playwright/test";
import { corsHeaders, fulfillCorsPreflight } from "./utils/cors";

const propertyId = "10090000-0000-4000-8000-000000000001";
const sourceId = "10090000-0000-4000-8000-000000000002";
const channelId = "10090000-0000-4000-8000-000000000003";
const operationId = "10090000-0000-4000-8000-000000000004";
const token = "x".repeat(43);
const path = `/setup/airbnb-return/${propertyId}/${sourceId}`;
const success = `?success=true&channel_id=${channelId}&token=${token}`;
// Requires AIRBNB_IMPORT_CALLBACK_ENABLED=true in the isolated frontend.
test.skip(process.env.E2E_AIRBNB_IMPORT_CALLBACK !== "1", "Callback preview is opt-in");
for (const scenario of [
  "new-hotel",
  "success",
  "lost-response",
  "save-response-lost",
  "reload",
  "empty",
  "all-imported",
  "cancelled",
  "duplicate",
  "missing-token",
  "wrong-source",
  "denied",
] as const) {
  test(`Airbnb return: ${scenario}`, async ({ page, baseURL }) => {
    let starts = 0;
    let preparations = 0;
    let prepared = false;
    let commandId = "";
    let saves = 0;
    const receipts: Record<string, unknown> = {};
    const listingData = {
      contractVersion: "prepared-hotel-import.v1",
      property: {},
      rooms: ["Suite", "Other listing"].map((name, index) => ({
        id: `abb_${index}`,
        name,
        description: "",
        maxGuests: 2,
        maxAdults: null,
        maxChildren: null,
        bedType: "",
        bedQuantity: null,
        bathroomType: "",
        sizeSquareMetres: null,
      })),
    };
    if (scenario === "empty") listingData.rooms = [];
    if (scenario === "all-imported")
      for (const room of listingData.rooms)
        receipts[`room:${room.id}`] = {
          itemId: `room:${room.id}`,
          status: "applied",
          resourceId: channelId,
        };
    let posts = 0;
    let reads = 0;
    let refreshes = 0;
    await page.route(/\/auth\/session(?:\?|$)/, async (route) => {
      refreshes++;
      expect(new URL(page.url()).search).toBe("");
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: {
          accessToken: "synthetic-access-token",
          organizationId: propertyId,
          organizationKind: "hotel_group",
          user: { id: propertyId, email: "owner@example.test", status: "active" },
        },
      });
    });
    if (scenario === "new-hotel") {
      await page.route("https://www.airbnb.com/**", async (route) => {
        await route.fulfill({
          contentType: "text/html",
          body: `<h1>Simulated Airbnb approval</h1><a href="${new URL(path + success, baseURL).href.replaceAll("&", "&amp;")}">Approve simulated connection</a>`,
        });
      });
      await page.route(/\/api\/pms\/properties\/.*\/channex/, async (route) => {
        if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
        expect(route.request().headers().authorization).toBe("Bearer synthetic-access-token");
        const pathname = new URL(route.request().url()).pathname;
        const pmsPath = `/api/pms/properties/${propertyId}/channex`;
        expect([pmsPath, `${pmsPath}/commands`, `${pmsPath}/operations/${operationId}`]).toContain(
          pathname,
        );
        expect(route.request().method()).toBe(pathname === `${pmsPath}/commands` ? "POST" : "GET");
        const send = (json: unknown, status = 200) =>
          route.fulfill({ status, headers: corsHeaders(route), json });
        if (pathname.endsWith("/channex"))
          return send({
            propertyId,
            connection: { status: "disconnected", externalPropertyId: null },
          });
        if (pathname.endsWith("/commands")) {
          preparations++;
          const command = route.request().postDataJSON();
          expect(command.operationType).toBe("enable");
          commandId = command.commandId;
          expect(command.idempotencyKey).toBe(`airbnb-prepare:${propertyId}:${commandId}`);
          return send(
            {
              operationId,
              propertyId,
              commandId,
              operationType: "enable",
              status: "queued",
            },
            202,
          );
        }
        expect(pathname).toBe(
          `/api/pms/properties/${propertyId}/channex/operations/${operationId}`,
        );
        prepared = true;
        return send({
          operationId,
          propertyId,
          commandId,
          operationType: "enable",
          status: "succeeded",
        });
      });
    }
    await page.route(/\/api\/hotel-setup\/properties\/.*\/airbnb-import\//, async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      expect(new URL(page.url()).search).toBe("");
      expect(new URL(page.url()).hash).toBe("");
      expect(route.request().headers().referer).toBeUndefined();
      if (route.request().headers().authorization !== "Bearer synthetic-access-token") {
        return route.fulfill({ status: 401, headers: corsHeaders(route), json: {} });
      }
      if (new URL(route.request().url()).pathname.endsWith("/start")) {
        expect(scenario).toBe("new-hotel");
        expect(new URL(route.request().url()).pathname).toBe(
          `/api/hotel-setup/properties/${propertyId}/airbnb-import/start`,
        );
        expect(route.request().postDataJSON()).toEqual({});
        expect(route.request().method()).toBe("POST");
        starts++;
        return route.fulfill({
          status: prepared ? 200 : 409,
          headers: corsHeaders(route),
          json: prepared
            ? { sourceId, url: "https://www.airbnb.com/oauth2/auth?synthetic=true" }
            : { code: "channex_binding_required" },
        });
      }
      if (new URL(route.request().url()).pathname.endsWith("/review")) {
        if (route.request().method() === "POST") {
          saves++;
          const body = route.request().postDataJSON();
          expect(body.sourceId).toBe(sourceId);
          expect(body.data.property).toEqual({});
          expect(body.data.rooms).toHaveLength(1);
          expect(body.data.rooms[0]).toMatchObject({
            id: "abb_0",
            maxAdults: 2,
            maxChildren: 0,
            bedType: "queen",
            bedQuantity: 1,
            bathroomType: "private",
          });
          receipts["room:abb_0"] = {
            itemId: "room:abb_0",
            status: "applied",
            resourceId: channelId,
          };
          return route.fulfill({
            status: scenario === "save-response-lost" ? 502 : 200,
            headers: corsHeaders(route),
            json: { items: Object.values(receipts) },
          });
        }
        return route.fulfill({
          status: 200,
          headers: corsHeaders(route),
          json: {
            import: { sourceId, propertyId, data: listingData, results: receipts },
            profile: { propertyId, profileRevision: 1, profile: { displayName: "Test Hotel" } },
            canImportRooms: true,
            canImportProperty: false,
            existingRooms: [],
          },
        });
      }
      if (route.request().method() === "POST") {
        posts++;
        expect(route.request().postDataJSON()).toEqual({ state: token, channelId });
        return route.fulfill({
          status: scenario === "lost-response" ? 502 : 200,
          headers: corsHeaders(route),
          json: { sourceId },
        });
      }
      reads++;
      await route.fulfill({
        status: scenario === "denied" ? 403 : 200,
        headers: corsHeaders(route),
        json: { sourceId: scenario === "wrong-source" ? propertyId : sourceId, data: {} },
      });
    });
    const query =
      scenario === "reload"
        ? ""
        : scenario === "cancelled"
          ? "?success=false"
          : scenario === "duplicate"
            ? `${success}&token=other`
            : scenario === "missing-token"
              ? `?success=true&channel_id=${channelId}`
              : success;
    let response;
    if (scenario === "new-hotel") {
      await page.goto(`/setup/airbnb-connect/${propertyId}`);
      await page.getByRole("button", { name: "Continue to Airbnb" }).click();
      await expect(page.getByRole("heading", { name: "Simulated Airbnb approval" })).toBeVisible();
      expect(starts).toBe(2);
      expect(preparations).toBe(1);
      const callbackResponse = page.waitForResponse(
        (response) => response.request().isNavigationRequest() && response.url().includes(path),
      );
      await page.getByRole("link", { name: "Approve simulated connection" }).click();
      response = await callbackResponse;
    } else response = await page.goto(`${path}${query}#discard`);
    expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
    const ready = [
      "new-hotel",
      "success",
      "lost-response",
      "save-response-lost",
      "reload",
      "empty",
      "all-imported",
    ].includes(scenario);
    await expect(page.getByRole("status").first()).toContainText(
      ready ? "saved for review" : scenario === "cancelled" ? "cancelled" : "could not confirm",
    );
    expect(new URL(page.url()).search).toBe("");
    const skipped = ["cancelled", "duplicate", "missing-token"].includes(scenario);
    expect(posts).toBe(skipped || scenario === "reload" ? 0 : 1);
    expect(reads).toBe(skipped ? 0 : 1);
    expect(refreshes).toBe(skipped ? 0 : scenario === "new-hotel" ? 2 : 1);
    await expect(page.getByRole("link", { name: "Return to hotel setup" })).toHaveAttribute(
      "href",
      `/setup?propertyId=${propertyId}`,
    );
    if (scenario === "empty" || scenario === "all-imported") {
      await expect(
        page.getByText("There are no remaining listings to import from this connection."),
      ).toBeVisible();
      expect(saves).toBe(0);
    }
    if (scenario === "new-hotel" || scenario === "success" || scenario === "save-response-lost") {
      await page.getByRole("button", { name: "Review prepared room data" }).click();
      await page.getByLabel("Maximum adults").first().fill("2");
      await page.getByLabel("Maximum children").first().fill("0");
      await page.getByLabel("Number of beds").first().fill("1");
      await page.getByLabel("Bed type").first().selectOption("queen");
      await page
        .getByRole("combobox", { name: /^Bathroom/ })
        .first()
        .selectOption("private");
      await page.getByRole("checkbox", { name: "Suite", exact: true }).check();
      await page.getByRole("button", { name: "Save selected items" }).click();
      if (scenario === "save-response-lost") {
        await expect(
          page.getByRole("region", { name: "Prepared hotel data" }).getByRole("alert"),
        ).toContainText("Import could not finish");
        await page.getByRole("button", { name: "Refresh", exact: true }).click();
        await expect(
          page.getByRole("region", { name: "Prepared hotel data" }).getByRole("alert"),
        ).toHaveCount(0);
      }
      await expect(
        page.getByText("Already imported. Your saved edits are preserved."),
      ).toBeVisible();
      expect(saves).toBe(1);
      await expect(
        page.getByRole("checkbox", { name: "Other listing", exact: true }),
      ).not.toBeChecked();
      await page.reload();
      await expect(page.getByRole("status").first()).toContainText("saved for review");
      await page.getByRole("button", { name: "Review prepared room data" }).click();
      await expect(
        page.getByText("Already imported. Your saved edits are preserved."),
      ).toBeVisible();
      expect(posts).toBe(1);
      expect(reads).toBe(2);
    }
  });
}
