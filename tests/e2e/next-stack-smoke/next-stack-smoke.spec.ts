import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type TestInfo,
} from "@playwright/test";

import {
  JsonApi,
  NEXT_STACK_ORIGINS,
  arrayField,
  authenticateSyntheticPlatformAdmin,
  authenticateSyntheticPmsUser,
  createSyntheticPlatformAdmin,
  createSyntheticUser,
  fillSecret,
  futureStay,
  loadSmokeEnvironment,
  loginPms,
  publicApi,
  readAuthSession,
  record,
  recordField,
  signUpSyntheticHotelOwner,
  smokeRecoveryReceipt,
  stringField,
  targetApi,
  type SmokeEnvironment,
  type SyntheticPlatformAdmin,
  type SyntheticUser,
} from "./support";
import {
  GUEST_NAME,
  bookOnLivePage,
  cancelOnLivePage,
  stayRoom,
  waitForRoomsLeft,
  type BookingResource,
} from "./booking-lifecycle";
import { cleanupSmokeResources, recoverSmokeProperty, type HotelResource } from "./cleanup";
import { completeFirstRun } from "./first-run";
import {
  confirmStaffInvitationDelivery,
  expectPms,
  runRestrictedStaffAcceptance,
} from "./restricted-staff";

type ForeignHotelResource = { accessToken: string; propertyId: string };
type HotelFlowResource = HotelResource & {
  ownerWorkosUserId: string;
  secondaryPropertyId: string;
  workosOrganizationId: string;
};
type SmokeResources = {
  bookings: BookingResource[];
  environment?: SmokeEnvironment;
  hotel?: HotelResource;
  platformAdmin?: SyntheticPlatformAdmin;
  retirementPropertyIds: string[];
  users: SyntheticUser[];
};

const smokeTest = test.extend<{ smokeResources: SmokeResources }>({
  smokeResources: [
    async ({ request }, use) => {
      const resources: SmokeResources = {
        bookings: [],
        retirementPropertyIds: [],
        users: [],
      };
      await use(resources);
      if (!resources.environment) return;

      const errors = await cleanupSmokeResources(
        request,
        resources.environment,
        resources.users,
        resources.bookings,
        resources.hotel,
        resources.platformAdmin,
        resources.retirementPropertyIds,
      );
      if (errors.length) {
        throw new AggregateError(
          errors,
          `Next-stack smoke cleanup failed: ${errors.map(errorMessage).join(" | ")}`,
        );
      }
    },
    { timeout: 5 * 60_000 },
  ],
});

test("API transport failures do not expose authorization", async () => {
  const secret = ["sk", "test", "FAKESECRET"].join("_");
  const failure = new Error(`authorization: Bearer ${secret}`);
  const fail = () => Promise.reject(failure);
  const request = { fetch: fail } as unknown as APIRequestContext;
  const api = new JsonApi(request, "https://example.test", `Bearer ${secret}`, fail);

  await expect(api.json("GET", "/resource")).rejects.toThrow(/^GET \/resource request failed\.$/);
  await expect(api.deleteIfPresent("/resource")).rejects.toThrow(
    /^DELETE \/resource request failed\.$/,
  );
  await expect(expectPms(secret, "/resource", 200, undefined, fail)).rejects.toThrow(
    /^GET \/resource request failed\.$/,
  );
});

test("API error responses redact configured secrets", async () => {
  const previousPassword = process.env.NEXT_STACK_SMOKE_PASSWORD;
  const previousWorkosKey = process.env.WORKOS_API_KEY;
  const password = ["response", "password", "sentinel", "value"].join("/");
  const workosKey = ["sk", "test", "response", "sentinel"].join("_");
  const bearer = ["dynamic", "access", "sentinel"].join(".");
  process.env.NEXT_STACK_SMOKE_PASSWORD = password;
  process.env.WORKOS_API_KEY = workosKey;
  const request = {} as APIRequestContext;
  const respond = () =>
    Promise.resolve(
      new Response(
        `password=${encodeURIComponent(password)} key=${Buffer.from(workosKey).toString("base64")} authorization=${encodeURIComponent(`Bearer ${bearer}`)} token=${bearer}`,
        { status: 500 },
      ),
    );

  try {
    const api = new JsonApi(request, "https://example.test", `Bearer ${bearer}`, respond);
    await expect(api.json("POST", "/resource")).rejects.toThrow(
      "POST /resource returned 500: password=[REDACTED] key=[REDACTED] authorization=[REDACTED] token=[REDACTED]",
    );
  } finally {
    if (previousPassword === undefined) delete process.env.NEXT_STACK_SMOKE_PASSWORD;
    else process.env.NEXT_STACK_SMOKE_PASSWORD = previousPassword;
    if (previousWorkosKey === undefined) delete process.env.WORKOS_API_KEY;
    else process.env.WORKOS_API_KEY = previousWorkosKey;
  }
});

test("secret input avoids value-bearing Playwright steps", async ({ page }) => {
  const secret =
    process.env.NEXT_STACK_SMOKE_PASSWORD ?? ["synthetic", "evidence", "secret"].join("-");
  await page.setContent(`
    <label>Password <input type="password" /></label>
    <output>0</output>
    <script>
      document.querySelector("input").addEventListener("input", (event) => {
        document.querySelector("output").textContent = String(event.target.value.length);
      });
    </script>
  `);

  await fillSecret(page.getByLabel("Password"), secret);

  expect(await page.locator("output").textContent()).toBe(String(secret.length));
});

test("staff delivery accepts an exact provider-confirmed delivered invitation", () => {
  expect(
    confirmStaffInvitationDelivery({
      delivery: "delivered",
      providerInvitationId: "invitation_exact",
    }),
  ).toBe("invitation_exact");
});

test("staff delivery resolves an ambiguous API outcome from exact provider evidence", () => {
  expect(
    confirmStaffInvitationDelivery({
      delivery: "unknown",
      providerInvitationId: "invitation_exact",
    }),
  ).toBe("invitation_exact");
});

test("staff delivery fails when provider confirmation errors", () => {
  const providerError = new Error("provider unavailable");
  const failure = (() => {
    try {
      confirmStaffInvitationDelivery({
        delivery: "unknown",
        providerInvitationId: "",
        providerLookupError: providerError,
      });
    } catch (error) {
      return error;
    }
  })();

  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([providerError]);
});

test("staff delivery rejects non-delivery outcomes", () => {
  expect(() =>
    confirmStaffInvitationDelivery({
      delivery: "not_ready",
      providerInvitationId: "invitation_exact",
    }),
  ).toThrow("Unexpected staff invitation delivery outcome: not_ready");
});

test("cleanup refreshes hotel authentication before PMS fallback", async () => {
  const environment: SmokeEnvironment = {
    emailDomain: "example.test",
    password: "synthetic-password",
    runId: "20260903123456-deadbeef",
    workosApiKey: "sk_test_synthetic",
  };
  const owner: SyntheticUser = {
    id: "hotel-owner",
    email: "hotel-owner@example.test",
    firstName: "Hotel",
    lastName: "Owner",
    role: "hotel",
  };
  const decoy: SyntheticUser = {
    ...owner,
    id: "other-hotel-owner",
    email: "other-hotel-owner@example.test",
  };
  const booking: BookingResource = {
    bookingId: "booking-1",
    email: "guest@example.test",
    mode: "instant",
    resolved: false,
    slug: "synthetic-hotel",
  };
  const calls: string[] = [];
  const targetCalls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? "GET";
    if (url.origin === NEXT_STACK_ORIGINS.api) {
      expect(init?.headers).toMatchObject({ authorization: "Bearer fresh-access-token" });
      calls.push("target");
      targetCalls.push(`${method} ${url.pathname}`);
      return jsonResponse({});
    }
    if (url.pathname === "/user_management/users" && method === "GET") {
      return jsonResponse({ data: [] });
    }
    if (url.pathname === "/user_management/organization_memberships" && method === "GET") {
      return jsonResponse({ data: [] });
    }
    if (url.pathname.startsWith("/user_management/users/") && method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected test request: ${method} ${url}`);
  }) as typeof globalThis.fetch;
  const request = {
    async post(url: string, options: unknown) {
      calls.push("login");
      expect(url).toBe(`${NEXT_STACK_ORIGINS.pms}/auth/password/login`);
      expect(options).toEqual({
        headers: { origin: NEXT_STACK_ORIGINS.pms },
        data: { email: owner.email, password: environment.password, surface: "pms-web" },
      });
      return {
        ok: () => true,
        text: async () => JSON.stringify({ accessToken: "fresh-access-token" }),
      };
    },
    async fetch(url: string, options: { data?: unknown; method?: string }) {
      calls.push("public");
      expect({ url, ...options }).toMatchObject({
        url: `${NEXT_STACK_ORIGINS.api}/api/booking-web/hotels/${booking.slug}/bookings/${booking.bookingId}/cancel`,
        method: "POST",
        data: { guestEmail: booking.email },
      });
      return {
        ok: () => false,
        status: () => 409,
        text: async () => JSON.stringify({ message: "Cancellation policy conflict." }),
      };
    },
  } as unknown as APIRequestContext;

  try {
    const errors = await cleanupSmokeResources(request, environment, [decoy, owner], [booking], {
      api: {
        async json() {
          throw new Error("Expired hotel API must not be reused.");
        },
      } as unknown as JsonApi,
      ownerWorkosUserId: owner.id,
      propertyId: "property-1",
    });
    expect(errors).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(booking.resolved).toBe(true);
  expect(calls).toEqual(["login", "public", "target"]);
  expect(targetCalls).toEqual([
    "POST /api/pms/properties/property-1/reservations/booking-1/cancel",
  ]);
});

test("ordinary cleanup reconciles an untracked synthetic booking before retirement", async () => {
  const runId = "20260831123456-deadbeef";
  const propertyId = "11111111-1111-4111-8111-111111111111";
  const environment: SmokeEnvironment = {
    emailDomain: "example.test",
    password: "synthetic-password",
    runId,
    workosApiKey: "sk_test_synthetic",
  };
  const platformAdmin: SyntheticPlatformAdmin = {
    accessToken: "initial-token",
    email: `qa-next-platform-${runId}@example.test`,
    membershipId: "membership-platform",
    userId: "user-platform",
  };
  const calls: string[] = [];
  const bookings: BookingResource[] = [];
  let platformAdminDeleted = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/platform/admin/bookings/recover-next-stack-smoke") {
      calls.push(`recover:${String(init?.body)}`);
      return jsonResponse({ outcome: "resolved", bookings: ["untracked-booking"] });
    }
    if (url.pathname === `/api/platform/admin/properties/${propertyId}/retirement-impact`) {
      calls.push("retirement-impact");
      return jsonResponse({ lifecycleRevision: 7, lifecycleStatus: "active" });
    }
    if (url.pathname === `/api/platform/admin/properties/${propertyId}/retire`) {
      calls.push("retire");
      return jsonResponse({ lifecycleStatus: "retired" });
    }
    if (url.pathname === "/user_management/users" && method === "GET") {
      const isPlatformAdmin = url.searchParams.get("email") === platformAdmin.email;
      return jsonResponse({
        data:
          isPlatformAdmin && !platformAdminDeleted
            ? [{ email: platformAdmin.email, id: platformAdmin.userId }]
            : [],
      });
    }
    if (url.pathname === "/user_management/organization_memberships" && method === "GET") {
      return jsonResponse({ data: [] });
    }
    if (url.pathname === `/user_management/users/${platformAdmin.userId}` && method === "DELETE") {
      platformAdminDeleted = true;
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected test request: ${method} ${url}`);
  }) as typeof globalThis.fetch;
  const request = {
    async post() {
      return {
        ok: () => true,
        status: () => 200,
        text: async () => JSON.stringify({ accessToken: "fresh-token" }),
      };
    },
  } as unknown as APIRequestContext;

  try {
    const errors = await cleanupSmokeResources(
      request,
      environment,
      [],
      bookings,
      undefined,
      platformAdmin,
      [propertyId],
    );
    expect(errors).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(calls.map((call) => call.split(":", 1)[0])).toEqual([
    "recover",
    "retirement-impact",
    "retire",
  ]);
  expect(JSON.parse(calls[0]!.slice("recover:".length))).toEqual({
    emailDomain: environment.emailDomain,
    propertyId,
    recoveryReceipt: smokeRecoveryReceipt(environment, runId, propertyId),
    runId,
  });
});

smokeTest(
  "a new hotel's first run goes live, takes a guest booking and hands off to PMS and staff",
  async ({ browser, request, smokeResources }, testInfo) => {
    smokeTest.skip(
      process.env.E2E_NEXT_STACK_SMOKE !== "1",
      "This live smoke must be acknowledged with E2E_NEXT_STACK_SMOKE=1.",
    );
    smokeTest.setTimeout(15 * 60_000);

    const environment = loadSmokeEnvironment();
    const { recoveryRunId, recoveryPropertyId, recoveryReceipt } = environment;
    if (recoveryRunId && recoveryPropertyId && recoveryReceipt) {
      await test.step("recover a failed synthetic property cleanup", () =>
        recoverSmokeProperty(request, environment, recoveryRunId, recoveryPropertyId));
      return;
    }
    smokeResources.environment = environment;
    const { users, bookings, retirementPropertyIds } = smokeResources;

    const platformAdmin = await test.step("create temporary platform lifecycle approver", () =>
      createSyntheticPlatformAdmin(request, environment));
    smokeResources.platformAdmin = platformAdmin;
    const foreignHotelContext = await browser.newContext();
    let foreignHotel: ForeignHotelResource;
    try {
      foreignHotel = await runForeignHotelFlow(foreignHotelContext, request, environment, users);
    } finally {
      await foreignHotelContext.close();
    }
    retirementPropertyIds.push(foreignHotel.propertyId);
    const registerHotel = (resource: HotelResource, retirementPropertyId = resource.propertyId) => {
      smokeResources.hotel = resource;
      retirementPropertyIds.push(retirementPropertyId);
    };

    const hotelContext = await browser.newContext();
    try {
      const completedHotel = await runHotelFlow(
        hotelContext,
        browser,
        request,
        environment,
        users,
        bookings,
        platformAdmin,
        testInfo,
        registerHotel,
      );
      const staff = await test.step("create a unique verified staff identity", async () => {
        const created = await createSyntheticUser(request, environment, "staff");
        users.push(created);
        return created;
      });
      await runRestrictedStaffAcceptance({
        assignedPropertyId: completedHotel.propertyId,
        browser,
        environment,
        foreignPropertyId: foreignHotel.propertyId,
        ownerApi: completedHotel.api,
        ownerWorkosOrganizationId: completedHotel.workosOrganizationId,
        ownerWorkosUserId: completedHotel.ownerWorkosUserId,
        replacementPropertyId: completedHotel.secondaryPropertyId,
        request,
        staff,
      });
    } finally {
      await hotelContext.close();
    }
  },
);

async function runHotelFlow(
  context: BrowserContext,
  browser: Browser,
  request: APIRequestContext,
  environment: SmokeEnvironment,
  users: SyntheticUser[],
  bookings: BookingResource[],
  platformAdmin: SyntheticPlatformAdmin,
  testInfo: TestInfo,
  registerHotel: (resource: HotelResource, retirementPropertyId?: string) => void,
): Promise<HotelFlowResource> {
  const page = await context.newPage();
  const { user, session, flow } =
    await test.step("sign a new hotel owner up in Booking Admin", async () => {
      const result = await signUpSyntheticHotelOwner(page, request, environment);
      users.push(result.user);
      expect(result.session.organizationKind).toBe("hotel_group");
      return result;
    });
  // New hotels set up through Booking Admin's first run (VAY-2247, ONBOARDING_V2_ENABLED).
  expect(flow, "Booking Admin opened the old setup wizard instead of the first run.").toBe(
    "first_run",
  );

  const owner = {
    api: targetApi(request, session.accessToken),
    ownerWorkosUserId: user.id,
    workosOrganizationId: session.workosOrganizationId,
  };
  const hotelName = `QA Next Hotel ${environment.runId}`;
  const room = { name: "QA Double Room", numberOfRooms: 2, maxGuests: 2, pricePerNight: "150" };
  const { propertyId, bookingUrl } = await completeFirstRun(
    page,
    {
      name: hotelName,
      streetAddress: "Alexanderplatz 1",
      postalCode: "10178",
      city: "Berlin",
      countryCode: "DE",
      receptionEmail: user.email,
      receptionPhone: "+49 30 5550102",
      room,
    },
    (id) => registerHotel({ ...owner, propertyId: id }),
  );
  await page.screenshot({ path: testInfo.outputPath("first-run-live.png"), fullPage: true });

  const slug =
    await test.step("the hotel is active and served at its booking address", async () => {
      // The first run makes the hotel active itself (VAY-2247, VAY-2140); Vayada approves nothing.
      // The temporary platform admin only reads the lifecycle here and retires the hotel at the end.
      const platformAdminApi = targetApi(
        request,
        await authenticateSyntheticPlatformAdmin(request, platformAdmin, environment.password),
      );
      await expect
        .poll(
          async () =>
            (
              await platformAdminApi.json<Record<string, unknown>>(
                "GET",
                `/api/platform/admin/properties/${propertyId}/retirement-impact`,
              )
            ).lifecycleStatus,
          { timeout: 90_000, intervals: [1_000, 2_000, 5_000] },
        )
        .toBe("active");
      const host = new URL(bookingUrl).hostname;
      const hostResponse = await request.get(
        `${NEXT_STACK_ORIGINS.api}/api/booking-web/hosts/${encodeURIComponent(host)}`,
      );
      expect(hostResponse).toBeOK();
      const hosted = record(await hostResponse.json());
      expect(hosted).toMatchObject({ hotel: { name: hotelName } });
      const hostedSlug = stringField(hosted, "slug");
      expect(host).toBe(`${hostedSlug}.next-booking.vayada.com`);
      const publicPage = await context.newPage();
      await publicPage.goto(bookingUrl);
      await expect(publicPage.getByRole("heading", { name: hotelName }).first()).toBeVisible();
      await expect(
        publicPage.getByRole("heading", { name: /Unable to Load Hotel|isn't online/ }),
      ).toHaveCount(0);
      await publicPage.close();
      return hostedSlug;
    });

  await test.step("the owner's dashboard opens on the new hotel", async () => {
    // Before any booking exists, so no new-booking notice covers the page.
    await page.getByRole("button", { name: "Go to my dashboard" }).click();
    await page.waitForURL(
      (url) => url.origin === NEXT_STACK_ORIGINS.bookingAdmin && url.pathname === "/dashboard",
      { timeout: 45_000 },
    );
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByText(hotelName, { exact: true }).first()).toBeVisible({
      timeout: 45_000,
    });
  });

  const stay = futureStay();
  const roomTypeId = await test.step("guests see the first run's room and price", async () => {
    const catalog = await publicApi(request).json<Record<string, unknown>>(
      "GET",
      `/api/booking-web/hotels/${encodeURIComponent(slug)}/pricing-offers`,
    );
    expect(catalog.version).toBe("public-pricing-offers.v1");
    const rooms = arrayField(catalog, "rooms").map(record);
    expect(rooms.map((candidate) => candidate.name)).toEqual([room.name]);
    const id = stringField(rooms[0]!, "roomTypeId");
    // Two nights at the owner's 150 a night, paid at the hotel.
    expect(arrayField(await stayRoom(request, slug, id, stay), "offers")).toContainEqual(
      expect.objectContaining({ status: "priced", totalMinor: "30000", currency: "EUR" }),
    );
    await waitForRoomsLeft(request, slug, id, stay, room.numberOfRooms);
    return id;
  });

  const guestBooking = await test.step("a guest books the room on the live booking page", () =>
    bookOnLivePage({
      browser,
      bookingUrl,
      bookings,
      environment,
      roomName: room.name,
      roomTypeId,
      slug,
      stay,
    }));
  await waitForRoomsLeft(request, slug, roomTypeId, stay, room.numberOfRooms - 1);

  await test.step("the owner sees the guest's booking in PMS", async () => {
    const pmsApi = targetApi(
      request,
      await authenticateSyntheticPmsUser(request, user, environment.password),
    );
    const read = async () =>
      recordField(
        await pmsApi.json(
          "GET",
          `/api/pms/properties/${propertyId}/reservations/${guestBooking.bookingId}`,
        ),
        "item",
      );
    // An accepted booking reaches PMS through a background job.
    await expect
      .poll(
        () =>
          read().then(
            () => "found",
            (error: unknown) => (error instanceof Error ? error.message : String(error)),
          ),
        { timeout: 90_000, intervals: [2_000, 5_000] },
      )
      .toBe("found");
    expect(recordField(await read(), "primaryGuest").email).toBe(guestBooking.email);
    await loginPms(page, user, environment.password);
    await page.goto(`${NEXT_STACK_ORIGINS.pms}/bookings/${guestBooking.bookingId}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      guestBooking.bookingReference,
      { timeout: 45_000 },
    );
    await expect(page.getByText(GUEST_NAME, { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("pms-guest-booking.png"), fullPage: true });
  });

  await test.step("the guest cancels on the live booking page", async () => {
    const resource = bookings.find(({ bookingId }) => bookingId === guestBooking.bookingId)!;
    await cancelOnLivePage({ browser, bookingUrl, booking: guestBooking, resource });
    await waitForRoomsLeft(request, slug, roomTypeId, stay, room.numberOfRooms);
  });

  return test.step("create a replacement property for restricted staff", async () => {
    // The sign-up token may have expired by now: read the owner's current Booking Admin session.
    await page.goto(`${NEXT_STACK_ORIGINS.bookingAdmin}/dashboard`);
    const api = targetApi(request, (await readAuthSession(page, "booking-admin")).accessToken);
    const property = await api.json<Record<string, unknown>>(
      "POST",
      "/api/hotel-setup/properties",
      {
        displayName: `QA Restricted Hotel ${environment.runId}`,
        propertyType: "hotel",
        location: {
          streetAddress: "Unter den Linden 1",
          postalCode: "10117",
          city: "Berlin",
          countryCode: "DE",
          timezone: "Europe/Berlin",
          latitude: null,
          longitude: null,
          localityPublic: false,
          geoPublic: false,
          mapDisplayMode: "hidden",
        },
        contacts: [
          { channelType: "email", value: user.email, purpose: "general", isPublic: false },
          { channelType: "phone", value: "+49 30 5550104", purpose: "general", isPublic: false },
        ],
      },
      { "Idempotency-Key": `next-smoke:${environment.runId}:restricted-property` },
    );
    const secondaryPropertyId = stringField(property, "propertyId");
    const completed = { ...owner, api, propertyId, secondaryPropertyId };
    registerHotel(completed, secondaryPropertyId);
    return completed;
  });
}

async function runForeignHotelFlow(
  context: BrowserContext,
  request: APIRequestContext,
  environment: SmokeEnvironment,
  users: SyntheticUser[],
): Promise<ForeignHotelResource> {
  const page = await context.newPage();
  const { user, session } = await signUpSyntheticHotelOwner(
    page,
    request,
    environment,
    "foreign",
    "+49 30 5550199",
  );
  users.push(user);
  expect(session.organizationKind).toBe("hotel_group");
  const api = targetApi(request, session.accessToken);
  await api.json(
    "PUT",
    "/api/hotel-setup/tracks",
    { selectedTracks: ["hotel_operations"], expectedRevision: 0 },
    { "Idempotency-Key": `next-smoke:${environment.runId}:foreign-tracks` },
  );
  const property = await api.json<Record<string, unknown>>(
    "POST",
    "/api/hotel-setup/properties",
    {
      displayName: `QA Foreign Hotel ${environment.runId}`,
      propertyType: "hotel",
      location: {
        streetAddress: "Potsdamer Platz 1",
        postalCode: "10785",
        city: "Berlin",
        countryCode: "DE",
        timezone: "Europe/Berlin",
        latitude: null,
        longitude: null,
        localityPublic: false,
        geoPublic: false,
        mapDisplayMode: "hidden",
      },
      contacts: [
        { channelType: "email", value: user.email, purpose: "general", isPublic: false },
        { channelType: "phone", value: "+49 30 5550199", purpose: "general", isPublic: false },
      ],
    },
    { "Idempotency-Key": `next-smoke:${environment.runId}:foreign-property` },
  );
  return { accessToken: session.accessToken, propertyId: stringField(property, "propertyId") };
}

function errorMessage(error: unknown): string {
  if (error instanceof AggregateError) {
    return [...error.errors].map(errorMessage).join(" + ");
  }
  return error instanceof Error ? error.message : String(error);
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
