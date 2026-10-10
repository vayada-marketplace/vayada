import { expect, test, type Page } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebRoomType,
} from "../support/pmsWebMocks";
import { watchPageHealth } from "../support/pageHealth";

// VAY-2102: a room edit must survive a reload, and a refused save must not show success.
const roomTypeId = "22222222-2222-4222-8222-222222222222";
const acceptedAt = "2026-10-10T08:00:00.000Z";

type StoredRoom = typeof pmsWebRoomType & {
  version: string;
  roomAmenitiesRevision: number;
  attributes: Record<string, unknown>;
};

test.describe("pms-web room edit save", () => {
  test("keeps edited room details after a reload", async ({ page }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    const stored = await mockRoomBackend(page);

    await page.goto(`/rooms/${roomTypeId}`);
    await expect(roomField(page, "Room Type Name")).toHaveValue("Alpine Suite");
    await roomField(page, "Room Type Name").fill("Lake Suite");
    await roomField(page, "Max Children").fill("2");
    await page.getByRole("button", { name: "Save Changes" }).click();

    await expect(page.getByText("Room type updated successfully")).toBeVisible();
    await expect(
      page.getByText("Publish prices again so guests can book this room."),
    ).toBeVisible();
    expect(stored.factWrites).toEqual([
      expect.objectContaining({
        expectedRevision: 3,
        facts: expect.objectContaining({
          name: "Lake Suite",
          occupancy: { maxGuests: 3, maxAdults: 2, maxChildren: 2 },
        }),
      }),
    ]);

    await page.reload();
    await expect(roomField(page, "Room Type Name")).toHaveValue("Lake Suite");
    await expect(roomField(page, "Max Children")).toHaveValue("2");
    await expect(page.getByRole("heading", { name: "Edit: Lake Suite" })).toBeVisible();
    await assertHealthy();
  });

  test("shows an error and no success banner when the save is refused", async ({ page }) => {
    const stored = await mockRoomBackend(page, { refuseFacts: true });

    await page.goto(`/rooms/${roomTypeId}`);
    await roomField(page, "Room Type Name").fill("Lake Suite");
    await page.getByRole("button", { name: "Save Changes" }).click();

    await expect(
      page.getByText("This room type was changed somewhere else. Reload the room and try again."),
    ).toBeVisible();
    await expect(page.getByText("Room type updated successfully")).toHaveCount(0);
    // A second click still sends the revision the form was loaded with: it must not
    // overwrite the change made elsewhere.
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect.poll(() => stored.factWrites.length).toBe(2);
    expect(stored.factWrites.map((write) => write.expectedRevision)).toEqual([3, 3]);
    await expect(page.getByText("Room type updated successfully")).toHaveCount(0);
    await page.reload();
    await expect(roomField(page, "Room Type Name")).toHaveValue("Alpine Suite");
    expect(stored.room.name).toBe("Alpine Suite");
  });
});

function roomField(page: Page, label: string) {
  return page.locator(
    `xpath=//label[starts-with(normalize-space(.), "${label}")]/../following-sibling::input[1]`,
  );
}

async function mockRoomBackend(page: Page, options: { refuseFacts?: boolean } = {}) {
  const state = {
    room: {
      ...pmsWebRoomType,
      roomTypeId,
      version: "room-type-facts-v3",
      roomAmenitiesRevision: 2,
      occupancyLimits: { total: 3, adults: 2, children: 1 },
      attributes: {
        beds: [{ type: "king", quantity: 1 }],
        bedrooms: 1,
        bathrooms: 1,
        bathroomType: "private",
        size: { value: 32, unit: "sqm" },
      },
    } as StoredRoom,
    factWrites: [] as Record<string, unknown>[],
  };

  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await page.route("**/api/identity/staff/self-access", (route) =>
    route.fulfill({
      json: {
        membershipId: "test-owner",
        roleKey: "hotel_owner",
        permissions: ["pms.operations.read", "pms.operations.manage", "pms.rooms_rates.read"],
      },
    }),
  );
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-types/${roomTypeId}`,
    (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ json: { propertyId: PMS_WEB_PROPERTY_ID, item: state.room } })
        : route.fulfill({ status: 500, json: { code: "unexpected_location_write" } }),
  );

  const setupPath = `**/api/pms/setup/properties/${PMS_WEB_PROPERTY_ID}/room-types/${roomTypeId}`;
  await page.route(setupPath, async (route) => {
    const body = route.request().postDataJSON() as {
      expectedRevision: number;
      facts: {
        name: string;
        description: string;
        category: string | null;
        occupancy: { maxGuests: number; maxAdults: number; maxChildren: number };
        beds: unknown[];
        bedrooms: number | null;
        bathrooms: number | null;
        bathroomType: string;
        size: unknown;
      };
    };
    state.factWrites.push(body);
    if (options.refuseFacts) {
      return route.fulfill({
        status: 409,
        json: { code: "room_facts_revision_conflict", currentRevision: 4 },
      });
    }
    const revision = body.expectedRevision + 1;
    const { facts } = body;
    state.room = {
      ...state.room,
      version: `room-type-facts-v${revision}`,
      name: facts.name,
      description: facts.description,
      category: facts.category ?? "",
      occupancyLimits: {
        total: facts.occupancy.maxGuests,
        adults: facts.occupancy.maxAdults,
        children: facts.occupancy.maxChildren,
      },
      attributes: {
        ...state.room.attributes,
        beds: facts.beds,
        bedrooms: facts.bedrooms,
        bathrooms: facts.bathrooms,
        bathroomType: facts.bathroomType,
        size: facts.size,
      },
    };
    return route.fulfill({
      json: {
        contractVersion: "pms-room-facts.v1",
        outcome: "updated",
        roomType: {
          contractVersion: "pms-room-facts.v1",
          propertyId: PMS_WEB_PROPERTY_ID,
          roomTypeId,
          roomFactsRevision: revision,
          lifecycle: "active",
          facts,
          createdAt: acceptedAt,
          updatedAt: acceptedAt,
        },
        acceptedAt,
      },
    });
  });
  await page.route(`${setupPath}/capacity`, (route) =>
    route.fulfill({
      json: {
        contractVersion: "pms-room-facts.v1",
        propertyId: PMS_WEB_PROPERTY_ID,
        roomTypeId,
        roomUnitsRevision: 2,
        activeUnitCount: 1,
        capturedAt: acceptedAt,
      },
    }),
  );
  await page.route(`${setupPath}/units`, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            contractVersion: "pms-room-facts.v1",
            propertyId: PMS_WEB_PROPERTY_ID,
            roomTypeId,
            roomUnitId: "33333333-3333-4333-8333-333333333333",
            lifecycle: "active",
            operationalLabel: "Alpine Suite 1",
            operationalLabelStatus: "verified",
          },
        ],
      },
    }),
  );
  return state;
}
