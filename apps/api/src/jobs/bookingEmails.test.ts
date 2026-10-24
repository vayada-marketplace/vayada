import { describe, expect, it } from "vitest";
import type { QueryResultRow } from "pg";

import {
  BOOKING_EMAIL_QUEUE,
  BOOKING_FINAL_CONFIRMATION_EMAIL_JOB_TYPE,
  BOOKING_RESERVED_PENDING_PAYMENT_EMAIL_JOB_TYPE,
  bookingLifecycleEmailJobKey,
  enqueueBookingLifecycleEmailJob,
  enqueueBookingTransitionNotifications,
  type BookingLifecycleEmailInput,
} from "./bookingEmails.js";

describe("booking lifecycle email jobs", () => {
  it("rejects unverified booking money before serializing or queueing email", async () => {
    const target = createTargetEmailStore();
    const input = bookingEmailInput({ kind: "final_confirmation" });
    input.booking.bookingMetadata = { airbnbMoneyStatus: "unverified" };
    await expect(enqueueBookingLifecycleEmailJob(target, input)).rejects.toThrow(
      "booking_amount_unverified",
    );
    expect(target.calls).toHaveLength(0);
  });
  it("suppresses transition notifications with unverified booking money", async () => {
    const target = createTargetEmailStore({ bookingMetadata: { airbnbMoneyStatus: "unverified" } });
    expect(
      await enqueueBookingTransitionNotifications(target, {
        propertyId: "f2000000-0000-0000-0000-000000000951",
        guestBookingId: "book_bank_001",
        occurredAt: "2026-09-01T00:00:00.000Z",
        transition: { eventType: "guest_booking.confirmed", toStatus: "confirmed" },
      }),
    ).toEqual([]);
    expect(target.calls.some((call) => call.text.includes("INSERT"))).toBe(false);
  });
  it("includes every accommodation name in confirmation email content", async () => {
    const target = createTargetEmailStore();
    const input = bookingEmailInput({ kind: "final_confirmation" });
    input.booking.accommodation = "2 × Double + 1 × Twin";
    await enqueueBookingLifecycleEmailJob(target, input);
    const payload = JSON.parse(
      String(target.requiredCall("INSERT INTO platform.jobs").values?.[8]),
    );
    expect(payload.text).toContain("Accommodation: 2 × Double + 1 × Twin");
  });

  it("tells the guest where they'll stay once the stay is confirmed (VAY-2322)", async () => {
    const propertyLocation = {
      streetAddress: "Marienplatz 1",
      area: "Altstadt",
      postalCode: "80331",
      city: "Munich",
      countryCode: "DE",
      latitude: 48.137154,
      longitude: 11.576124,
      arrivalDirections: "Ring the bell at the side door.",
    };
    const maps = "Open in Google Maps: https://www.google.com/maps/dir/?api=1&destination=";
    const atProperty = [
      "Where you'll stay:",
      "Hotel Alpenrose · Double",
      "Marienplatz 1, Altstadt, 80331 Munich, Germany",
      "Arrival directions: Ring the bell at the side door.",
      `${maps}48.137154,11.576124`,
    ].join("\n");
    const villa = (name: string, attributes: Record<string, unknown> = {}) => ({
      name,
      attributes: {
        locationSource: "custom",
        locationAddress: "Fraunhoferstraße 5, 80469 München",
        latitude: 48.1301234,
        longitude: 11.5734567,
        ...attributes,
      },
    });
    const text = async (
      kind: BookingLifecycleEmailInput["kind"],
      booking: Partial<BookingLifecycleEmailInput["booking"]> = {},
    ) => {
      const target = createTargetEmailStore();
      const input = bookingEmailInput({ kind });
      Object.assign(input.booking, {
        propertyLocation,
        bookedRooms: [{ name: "Double", attributes: { locationSource: "property" } }],
        ...booking,
      });
      await enqueueBookingLifecycleEmailJob(target, input);
      return String(
        JSON.parse(String(target.requiredCall("INSERT INTO platform.jobs").values?.[8])).text,
      );
    };

    for (const kind of ["final_confirmation", "booking_accepted", "booking_updated"] as const)
      expect(await text(kind)).toContain(`\n\n${atProperty}\n\nBooking reference: B-BANK-001`);
    for (const kind of [
      "request_received",
      "reserved_pending_payment",
      "booking_rejected",
      "booking_canceled",
      "host_new_booking",
      "host_request_updated",
    ] as const)
      expect(await text(kind)).not.toContain("Where you'll stay");

    // Older rooms count as the property's without a pin of their own away from it, and so does a room on the
    // property's pin without an address of its own. Rooms at one villa share its paragraph; an approximate one
    // gets the exact address with a word on why; a room elsewhere with nothing saved is left out.
    const mixed = await text("final_confirmation", {
      propertyLocation: { ...propertyLocation, arrivalDirections: null },
      bookedRooms: [
        { name: "Double", attributes: {} },
        { name: "Twin", attributes: { latitude: 48.137154, longitude: 11.576124 } },
        {
          name: "Studio",
          attributes: { locationSource: "custom", latitude: 48.137154, longitude: 11.576124 },
        },
        villa("Beach Villa", { locationPrecision: "approximate", locationArea: "Isarvorstadt" }),
        villa("Garden Villa"),
        { name: "Lake Lodge", attributes: { locationSource: "custom" } },
      ],
    });
    expect(mixed).toContain(
      [
        "Where you'll stay:",
        "Hotel Alpenrose · Double, Twin, Studio",
        "Marienplatz 1, Altstadt, 80331 Munich, Germany",
        `${maps}48.137154,11.576124`,
        "",
        "Beach Villa, Garden Villa",
        "Fraunhoferstraße 5, 80469 München",
        "Your booking page showed the area, Isarvorstadt. This is the exact address.",
        `${maps}48.1301234,11.5734567`,
        "",
        "Booking reference: B-BANK-001",
      ].join("\n"),
    );
    expect(mixed).not.toMatch(/Lake Lodge|Arrival directions/);

    // Only a villa: no paragraph for the property. Without a pin, the link looks the address up.
    const onlyVilla = await text("booking_accepted", {
      bookedRooms: [villa("Beach Villa", { latitude: undefined, longitude: undefined })],
    });
    expect(onlyVilla).toContain(
      `Where you'll stay:\nBeach Villa\nFraunhoferstraße 5, 80469 München\n${maps}Fraunhoferstra%C3%9Fe%205%2C%2080469%20M%C3%BCnchen\n\n`,
    );
    expect(onlyVilla).not.toContain("Marienplatz");
    expect(
      await text("final_confirmation", {
        propertyLocation: { ...propertyLocation, latitude: null, longitude: null, area: null },
      }),
    ).toContain(`${maps}Marienplatz%201%2C%2080331%20Munich%2C%20Germany`);

    // Nothing to show: a property without an address or pin, rooms booked elsewhere with nothing saved, or no
    // snapshot at all.
    const empty = {
      ...propertyLocation,
      streetAddress: null,
      area: null,
      postalCode: null,
      city: null,
      latitude: null,
      longitude: null,
      arrivalDirections: null,
    };
    for (const booking of [
      { propertyLocation: empty, bookedRooms: [] },
      { bookedRooms: [{ name: "Lake Lodge", attributes: { locationSource: "custom" } }] },
      { propertyLocation: null, bookedRooms: null },
    ])
      expect(await text("final_confirmation", booking)).not.toContain("Where you'll stay");
  });

  it("reads the property's place and the booked rooms with the booking (VAY-2322)", async () => {
    const target = createTargetEmailStore({
      propertyLocation: {
        streetAddress: "Marienplatz 1",
        area: null,
        postalCode: "80331",
        city: "Munich",
        countryCode: "DE",
        latitude: null,
        longitude: null,
        arrivalDirections: "Side door.",
      },
      bookedRooms: [{ name: "Double", attributes: { locationSource: "property" } }],
    });
    await enqueueBookingTransitionNotifications(target, {
      propertyId: "f2000000-0000-0000-0000-000000000951",
      guestBookingId: "book_bank_001",
      occurredAt: "2026-09-01T10:00:00.000Z",
      transition: {
        eventType: "guest_booking.payment_received",
        fromStatus: "pending_payment",
        toStatus: "confirmed",
      },
    });
    const payloads = target.calls
      .filter((call) => call.text.includes("INSERT INTO platform.jobs"))
      .map((call) => JSON.parse(String(call.values?.[8])));
    const guest = payloads.find((payload) => payload.recipientRole === "guest");
    const host = payloads.find((payload) => payload.recipientRole === "host");
    expect(guest.text).toContain(
      "Where you'll stay:\nHotel Alpenrose · Double\nMarienplatz 1, 80331 Munich, Germany\nArrival directions: Side door.",
    );
    expect(host.text).not.toContain("Where you'll stay");
  });

  it("deduplicates retries but sends each accepted host date revision", async () => {
    const target = createTargetEmailStore();
    const enqueue = (revision: string) =>
      enqueueBookingLifecycleEmailJob(
        target,
        bookingEmailInput({
          kind: "booking_updated",
          transition: {
            eventType: "guest_booking.host_dates_updated",
            fromStatus: "confirmed",
            toStatus: "confirmed",
            revision,
          },
        }),
      );
    const first = await enqueue("preview-one");
    const retry = await enqueue("preview-one");
    const second = await enqueue("preview-two");
    expect(retry.jobKey).toBe(first.jobKey);
    expect(second.jobKey).not.toBe(first.jobKey);
    expect(target.requiredCall("INSERT INTO platform.jobs").values?.[2]).toBe(
      "email.booking-updated",
    );
  });

  it.each([undefined, "  ", "Sorry.\r\n\r\nCall us.\r\n<script>alert(1)</script>"])(
    "renders optional cancellation text safely with paragraphs: %s",
    async (guestMessage) => {
      const target = createTargetEmailStore();
      await enqueueBookingLifecycleEmailJob(
        target,
        bookingEmailInput({
          kind: "booking_canceled",
          guestMessage,
          transition: {
            eventType: "guest_booking.canceled",
            fromStatus: "confirmed",
            toStatus: "canceled",
            reason: "property_cancellation",
          },
        }),
      );
      const payload = JSON.parse(
        String(target.requiredCall("INSERT INTO platform.jobs").values?.[8]),
      );
      expect(payload.subject).toContain("Booking canceled");
      expect(payload.text).toContain("We've canceled your booking");
      expect(payload.html).toBeUndefined();
      if (guestMessage?.trim())
        expect(payload.text).toContain(`Message from us:\n${guestMessage.replace(/\r\n/g, "\n")}`);
      else expect(payload.text).not.toContain("Message from us:");
    },
  );

  it("enqueues a bank-transfer email without storing credentials", async () => {
    const target = createTargetEmailStore();

    const result = await enqueueBookingLifecycleEmailJob(
      target,
      bookingEmailInput({
        kind: "reserved_pending_payment",
        paymentDeadlineAt: "2026-09-02T10:00:00.000Z",
        bankTransferDetails: {
          accountHolder: "Hotel Alpenrose GmbH",
          iban: "DE89370400440532013000",
          bic: "COBADEFFXXX",
        },
      }),
    );

    expect(result).toMatchObject({
      status: "queued",
      jobType: BOOKING_RESERVED_PENDING_PAYMENT_EMAIL_JOB_TYPE,
      jobKey: bookingLifecycleEmailJobKey("reserved_pending_payment", "book_bank_001", "guest", {
        eventType: "guest_booking.accepted",
        fromStatus: "pending_payment",
        toStatus: "confirmed",
      }),
    });

    const jobInsert = target.requiredCall("INSERT INTO platform.jobs");
    expect(jobInsert.values?.[1]).toBe(BOOKING_EMAIL_QUEUE);
    expect(jobInsert.values?.[2]).toBe(BOOKING_RESERVED_PENDING_PAYMENT_EMAIL_JOB_TYPE);

    const payload = JSON.parse(String(jobInsert.values?.[8]));
    expect(payload.emailProduct).toBe("booking");
    expect(jobInsert.text).toContain("ON CONFLICT (queue_name, job_key) DO NOTHING");
    expect(payload.subject).toContain("reserved pending payment");
    expect(payload.text).toContain("We've reserved your room");
    // 24-hour and readable, in UTC when the hotel's time zone isn't known (VAY-2195).
    expect(payload.text).toMatch(/Payment deadline: Wed, 2 Sept? 2026, 10:00 UTC/);
    expect(JSON.stringify(payload)).not.toContain("DE89370400440532013000");
    expect(payload.bankTransferDetails).toBeUndefined();
    expect(payload.requiresBankTransferInstructions).toBe(true);

    expect(target.requiredCall("INSERT INTO platform.domain_events").values?.[1]).toBe(
      "booking.notification.reserved_pending_payment_requested",
    );
    expect(target.requiredCall("INSERT INTO platform.product_audit_events").values?.[1]).toBe(
      "booking.notification.reserved_pending_payment_requested",
    );
  });

  it("renders confirmation resends without requesting protected bank instructions", async () => {
    const target = createTargetEmailStore();

    await enqueueBookingLifecycleEmailJob(
      target,
      bookingEmailInput({
        kind: "final_confirmation",
        resendKey: "booking.confirmation.resend:test",
      }),
    );

    const jobInsert = target.requiredCall("INSERT INTO platform.jobs");
    expect(jobInsert.values?.[2]).toBe(BOOKING_FINAL_CONFIRMATION_EMAIL_JOB_TYPE);

    const payload = JSON.parse(String(jobInsert.values?.[8]));
    expect(payload.template).toBe("booking_final_confirmation");
    expect(payload.requiresBankTransferInstructions).toBe(false);
    expect(payload.text).toContain("We look forward to welcoming you!");
    expect(payload.text).not.toContain("You can look up your booking anytime");
    expect(payload.text.split("We look forward to welcoming you!")[1]).toBe("");
  });

  it.each(["pay_at_property", "credit_card", "bank_transfer", "cash"])(
    "does not expose the internal %s identifier in guest email copy",
    async (paymentMethod) => {
      const target = createTargetEmailStore();
      const input = bookingEmailInput({ kind: "final_confirmation" });
      input.booking.paymentMethod = paymentMethod;

      await enqueueBookingLifecycleEmailJob(target, input);

      const payload = JSON.parse(
        String(target.requiredCall("INSERT INTO platform.jobs").values?.[8]),
      );
      expect(payload.subject).not.toContain(paymentMethod);
      expect(payload.text).not.toContain(paymentMethod);
    },
  );

  // VAY-2195: every guest email shows stay dates as days, 24-hour times and the booking page's
  // "Pay at the hotel"; no raw YYYY-MM-DD or ISO instant is left in the text.
  it.each([
    ["final_confirmation", true, true],
    ["booking_accepted", true, true],
    ["booking_updated", true, true],
    ["request_received", true, false],
    ["booking_canceled", true, false],
    ["booking_rejected", false, false],
    ["booking_expired", false, false],
    ["reserved_pending_payment", false, false],
  ] as const)("renders the %s guest email as guests read it", async (kind, stay, details) => {
    const target = createTargetEmailStore();
    const input = bookingEmailInput({ kind, paymentDeadlineAt: "2026-09-02T10:00:00.000Z" });
    input.booking.paymentMethod =
      kind === "reserved_pending_payment" ? "bank_transfer" : "pay_at_property";
    input.booking.propertyTimeZone = "Asia/Makassar";
    await enqueueBookingLifecycleEmailJob(target, input);
    const { text } = JSON.parse(
      String(target.requiredCall("INSERT INTO platform.jobs").values?.[8]),
    ) as { text: string };
    if (stay) expect(text).toMatch(/Stay: Sat, 12 Sept? 2026 to Tue, 15 Sept? 2026/);
    if (details) expect(text).toContain("Payment method: Pay at the hotel");
    if (kind === "reserved_pending_payment")
      expect(text).toMatch(/Payment deadline: Wed, 2 Sept? 2026, 18:00 GMT\+8/);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}|\b(AM|PM)\b|Pay at Property/);
  });

  it("falls back to UTC for a time zone the runtime doesn't know", async () => {
    const target = createTargetEmailStore();
    const input = bookingEmailInput({ paymentDeadlineAt: "2026-09-02T10:00:00.000Z" });
    input.booking.propertyTimeZone = "Asia/Bali";
    await enqueueBookingLifecycleEmailJob(target, input);
    const { text } = JSON.parse(
      String(target.requiredCall("INSERT INTO platform.jobs").values?.[8]),
    ) as { text: string };
    expect(text).toMatch(/Payment deadline: Wed, 2 Sept? 2026, 10:00 UTC/);
  });

  it("keeps readable stay dates in the hotel's emails", async () => {
    const target = createTargetEmailStore();
    await enqueueBookingLifecycleEmailJob(
      target,
      bookingEmailInput({
        kind: "host_new_booking",
        recipient: { role: "host", email: "reservations@alpenrose.test" },
      }),
    );
    const { text } = JSON.parse(
      String(target.requiredCall("INSERT INTO platform.jobs").values?.[8]),
    ) as { text: string };
    expect(text).toMatch(/Stay: Sat, 12 Sept? 2026 to Tue, 15 Sept? 2026/);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("reads the hotel's time zone with the booking", async () => {
    const target = createTargetEmailStore();
    await enqueueBookingTransitionNotifications(target, {
      propertyId: "f2000000-0000-0000-0000-000000000951",
      guestBookingId: "book_bank_001",
      occurredAt: "2026-09-01T00:00:00.000Z",
      transition: { eventType: "guest_booking.confirmed", toStatus: "confirmed" },
    });
    expect(target.requiredCall('AS "hostEmail"').text).toContain(
      "FROM hotel_catalog.property_locations location",
    );
  });

  it("reuses the same customer-facing job for duplicate command retries", async () => {
    const target = createTargetEmailStore();
    const input = bookingEmailInput({
      kind: "final_confirmation",
      causationId: "finance.manual_payment.record:cmd-bank-paid-001",
    });

    const first = await enqueueBookingLifecycleEmailJob(target, input);
    const retry = await enqueueBookingLifecycleEmailJob(target, input);

    expect(first?.status).toBe("queued");
    expect(retry).toMatchObject({
      status: "idempotent_replay",
      jobId: first?.jobId,
      jobKey: first?.jobKey,
    });
    expect(
      target.calls.filter((call) => call.text.includes("INSERT INTO platform.jobs")),
    ).toHaveLength(2);
  });

  it("keeps existing guest-only callers compatible while lifecycle wiring migrates", async () => {
    const target = createTargetEmailStore();
    const input = bookingEmailInput({ kind: "final_confirmation" });
    delete input.recipient;
    delete input.transition;

    const result = await enqueueBookingLifecycleEmailJob(target, input);

    expect(result.jobKey).toBe(bookingLifecycleEmailJobKey("final_confirmation", "book_bank_001"));
    const payload = JSON.parse(
      String(target.requiredCall("INSERT INTO platform.jobs").values?.[8]),
    );
    expect(payload).toMatchObject({
      to: "guest@example.test",
      recipientRole: "guest",
      transition: {
        eventType: "guest_booking.payment_received",
        fromStatus: "pending_payment",
        toStatus: "confirmed",
      },
    });
  });

  it("resolves guest and host recipients for a confirmed lifecycle transition", async () => {
    const target = createTargetEmailStore();

    const enqueued = await enqueueBookingTransitionNotifications(target, {
      propertyId: "f2000000-0000-0000-0000-000000000951",
      guestBookingId: "book_bank_001",
      occurredAt: "2026-09-01T10:00:00.000Z",
      transition: {
        eventType: "guest_booking.payment_received",
        fromStatus: "pending_payment",
        toStatus: "confirmed",
      },
    });

    expect(enqueued).toHaveLength(2);
    const payloads = target.calls
      .filter((call) => call.text.includes("INSERT INTO platform.jobs"))
      .map((call) => JSON.parse(String(call.values?.[8])));
    expect(payloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ to: "guest@example.test", recipientRole: "guest" }),
        expect.objectContaining({ to: "reservations@alpenrose.test", recipientRole: "host" }),
      ]),
    );
    expect(enqueued.map((job) => job.jobKey)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(":recipient:guest:final_confirmation:v1"),
        expect.stringContaining(":recipient:host:host_new_booking:v1"),
      ]),
    );
  });

  it("uses current bank-transfer pending state for request and review notifications", async () => {
    const target = createTargetEmailStore({ paymentMethod: "bank_transfer" });

    const enqueued = await enqueueBookingTransitionNotifications(target, {
      propertyId: "f2000000-0000-0000-0000-000000000951",
      guestBookingId: "book_bank_001",
      occurredAt: "2026-09-01T10:00:00.000Z",
      transition: {
        eventType: "guest_booking.created",
        fromStatus: null,
        toStatus: "pending_payment",
      },
    });

    expect(enqueued.map((job) => job.jobType)).toEqual([
      "email.booking-request-received",
      "email.booking-host-review-required",
    ]);
  });

  it("sends pricing-v2 bank-transfer and PayPal guests the instructions and tells the hotel (VAY-2139)", async () => {
    const created = async (paymentMethod: string, paymentInstructions?: object) => {
      const target = createTargetEmailStore({
        paymentMethod,
        propertyTimeZone: "Europe/Zurich",
        bookingMetadata: { targetSource: "pricing_quote_draft", paymentInstructions },
      });
      const enqueued = await enqueueBookingTransitionNotifications(target, {
        propertyId: "f2000000-0000-0000-0000-000000000951",
        guestBookingId: "book_bank_001",
        occurredAt: "2026-09-01T10:00:00.000Z",
        transition: {
          eventType: "guest_booking.created",
          fromStatus: "draft",
          toStatus: "pending_payment",
        },
        paymentDeadlineAt: "2026-09-03T10:00:00.000Z",
      });
      expect(enqueued.map((job) => job.jobType)).toEqual([
        "email.booking-reserved-pending-payment",
        "email.booking-host-payment-pending",
      ]);
      const [guest, host] = target.calls
        .filter((call) => call.text.includes("INSERT INTO platform.jobs"))
        .map((call) => JSON.parse(String(call.values?.[8])));
      // The deadline in the hotel's own time, 24-hour, with its zone (VAY-2195).
      expect(guest.text).toMatch(/Payment deadline: Thu, 3 Sept? 2026, 12:00 CEST/);
      expect(host.text).toMatch(/Payment deadline: Thu, 3 Sept? 2026, 12:00 CEST/);
      expect(guest.text).toContain("the booking expires and the room is released");
      expect(host.recipientRole).toBe("host");
      expect(host.text).toContain("mark the payment as received in your PMS");
      return { guest, host };
    };
    const bank = await created("bank_transfer");
    expect(bank.guest.text).toContain("while we wait for your bank transfer");
    expect(bank.guest.requiresBankTransferInstructions).toBe(true);
    expect(bank.host.text).toContain("will pay by bank transfer");
    const paypal = await created("paypal", { paypalEmail: "pay@alpenrose.test" });
    expect(paypal.guest.text).toContain("while we wait for your PayPal payment");
    expect(paypal.guest.text).toContain("Please send it by PayPal to pay@alpenrose.test.");
    expect(paypal.guest.requiresBankTransferInstructions).toBe(false);
    expect(paypal.host.text).toContain("will pay by PayPal");
  });

  it("tells the guest and the hotel when a pricing-v2 bank transfer or PayPal payment never arrives", async () => {
    const target = createTargetEmailStore({
      paymentMethod: "paypal",
      bookingMetadata: { targetSource: "pricing_quote_draft", acceptanceMode: "request" },
    });
    const enqueued = await enqueueBookingTransitionNotifications(target, {
      propertyId: "f2000000-0000-0000-0000-000000000951",
      guestBookingId: "book_bank_001",
      occurredAt: "2026-09-03T10:00:01.000Z",
      transition: {
        eventType: "guest_booking.expired",
        fromStatus: "pending_payment",
        toStatus: "expired",
      },
    });
    expect(enqueued.map((job) => job.jobType)).toEqual([
      "email.booking-expired",
      "email.booking-host-payment-expired",
    ]);
    const [guest, host] = target.calls
      .filter((call) => call.text.includes("INSERT INTO platform.jobs"))
      .map((call) => JSON.parse(String(call.values?.[8])));
    expect(guest.text).toContain("We didn't receive your payment by the deadline");
    expect(host.text).toContain("its payment didn't arrive by the deadline");
  });

  it("waits for card authorization before notifying a future request-mode booking", async () => {
    const target = createTargetEmailStore({
      paymentMethod: "card",
      bookingMetadata: { acceptanceMode: "request" },
    });
    const input = {
      propertyId: "f2000000-0000-0000-0000-000000000951",
      guestBookingId: "book_bank_001",
      occurredAt: "2026-09-01T10:00:00.000Z",
    };

    await expect(
      enqueueBookingTransitionNotifications(target, {
        ...input,
        transition: { eventType: "guest_booking.created", fromStatus: null, toStatus: "draft" },
      }),
    ).resolves.toEqual([]);
    const enqueued = await enqueueBookingTransitionNotifications(target, {
      ...input,
      transition: {
        eventType: "guest_booking.payment_authorized",
        fromStatus: "draft",
        toStatus: "pending_payment",
      },
    });

    expect(enqueued.map((job) => job.jobType)).toEqual([
      "email.booking-request-received",
      "email.booking-host-review-required",
    ]);
  });

  it.each([
    ["guest_booking.accepted", "confirmed", "email.booking-reserved-pending-payment", null],
    ["guest_booking.rejected", "declined", "email.booking-rejected", null],
    ["guest_booking.expired", "expired", "email.booking-expired", null],
    ["guest_booking.canceled", "canceled", "email.booking-expired", "accepted_payment_expired"],
  ])(
    "maps %s to the appropriate guest lifecycle message",
    async (eventType, toStatus, jobType, reason) => {
      const target = createTargetEmailStore({ paymentMethod: "bank_transfer" });

      const enqueued = await enqueueBookingTransitionNotifications(target, {
        propertyId: "f2000000-0000-0000-0000-000000000951",
        guestBookingId: "book_bank_001",
        occurredAt: "2026-09-01T10:00:00.000Z",
        transition: { eventType, fromStatus: "pending_payment", toStatus, reason },
      });

      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]?.jobType).toBe(jobType);
    },
  );

  it("tells the hotel when a request it did not answer expires", async () => {
    const target = createTargetEmailStore({
      paymentMethod: "pay_at_property",
      bookingMetadata: { acceptanceMode: "request" },
    });
    const enqueued = await enqueueBookingTransitionNotifications(target, {
      propertyId: "f2000000-0000-0000-0000-000000000951",
      guestBookingId: "book_bank_001",
      occurredAt: "2026-09-01T10:00:00.000Z",
      transition: {
        eventType: "guest_booking.expired",
        fromStatus: "pending_payment",
        toStatus: "expired",
      },
    });
    expect(enqueued.map((job) => job.jobType)).toEqual([
      "email.booking-expired",
      "email.booking-host-request-expired",
    ]);
  });

  it.each([null, "", "invalid", "guest@example.test\nother@example.test"])(
    "rejects a directly supplied invalid host recipient: %s",
    async (email) => {
      const target = createTargetEmailStore();
      const input = bookingEmailInput({ kind: "host_request_updated" });
      input.recipient = { role: "host", email };
      await expect(enqueueBookingLifecycleEmailJob(target, input)).rejects.toThrow(
        "A valid host notification recipient is required.",
      );
      expect(target.calls).toHaveLength(0);
    },
  );

  it("records a missing host recipient without queuing an undeliverable job", async () => {
    const target = createTargetEmailStore({ hostEmail: null });

    const enqueued = await enqueueBookingTransitionNotifications(target, {
      propertyId: "f2000000-0000-0000-0000-000000000951",
      guestBookingId: "book_bank_001",
      occurredAt: "2026-09-01T10:00:00.000Z",
      transition: {
        eventType: "guest_booking.created",
        fromStatus: null,
        toStatus: "confirmed",
      },
    });

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.jobKey).toContain(":recipient:guest:");
    const payloads = target.calls
      .filter((call) => call.text.includes("INSERT INTO platform.jobs"))
      .map((call) => JSON.parse(String(call.values?.[8])));
    expect(payloads).toHaveLength(1);
    expect(payloads[0].recipientRole).toBe("guest");
    const audit = target.requiredCall("'booking.notification.missing_recipient'");
    expect(JSON.parse(String(audit.values?.[8]))).toMatchObject({
      reason: "host_recipient_missing",
      outcome: "blocked",
      recipientRole: "host",
    });
    const recipientQuery = target.requiredCall('AS "hostEmail"').text;
    expect(recipientQuery).toContain("contact.purpose = 'operations'");
    expect(recipientQuery).toContain(
      "contact.purpose = 'general' AND contact.source_system IN ('platform', 'booking')",
    );
    expect(recipientQuery).not.toContain("contact.purpose = 'creator'");
  });
});

type QueryCall = { text: string; values?: readonly unknown[] };

function createTargetEmailStore(snapshotOverrides: Record<string, unknown> = {}): {
  calls: QueryCall[];
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
  requiredCall(fragment: string): QueryCall;
} {
  const calls: QueryCall[] = [];
  const jobs = new Map<string, string>();
  let sequence = 0;

  return {
    calls,
    async query<T extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ): Promise<{ rows: T[] }> {
      calls.push({ text, values });
      if (text.includes('AS "hostEmail"')) {
        return {
          rows: [
            {
              propertyId: "f2000000-0000-0000-0000-000000000951",
              guestBookingId: "book_bank_001",
              bookingReference: "B-BANK-001",
              guestEmail: "guest@example.test",
              guestName: "Ada Guest",
              hostEmail: "reservations@alpenrose.test",
              propertyName: "Hotel Alpenrose",
              checkIn: "2026-09-12",
              checkOut: "2026-09-15",
              totalAmount: "600.00",
              balanceAmount: "200.00",
              currency: "EUR",
              paymentMethod: "card",
              bookingMetadata: {},
              ...snapshotOverrides,
            } as unknown as T,
          ],
        };
      }
      if (text.includes("INSERT INTO platform.domain_events")) {
        sequence += 1;
        return { rows: [{ eventId: `event_booking_email_${sequence}` } as unknown as T] };
      }
      if (text.includes("INSERT INTO platform.jobs")) {
        const jobKey = String(values?.[0]);
        const existingJobId = jobs.get(jobKey);
        if (existingJobId) {
          return { rows: [{ jobId: existingJobId, replay: true } as unknown as T] };
        }
        const jobId = `job_booking_email_${jobs.size + 1}`;
        jobs.set(jobKey, jobId);
        return { rows: [{ jobId, replay: false } as unknown as T] };
      }
      return { rows: [] as T[] };
    },
    requiredCall(fragment: string) {
      const call = calls.find((candidate) => candidate.text.includes(fragment));
      expect(call, fragment).toBeDefined();
      return call!;
    },
  };
}

function bookingEmailInput(
  overrides: Partial<BookingLifecycleEmailInput>,
): BookingLifecycleEmailInput {
  return {
    kind: "reserved_pending_payment",
    occurredAt: "2026-09-01T10:00:00.000Z",
    correlationId: "corr-booking-email-001",
    causationId: "booking.accept:book_bank_001",
    actor: { type: "user", userId: "f1000000-0000-0000-0000-000000000951" },
    recipient: { role: "guest", email: "guest@example.test" },
    transition: {
      eventType: "guest_booking.accepted",
      fromStatus: "pending_payment",
      toStatus: "confirmed",
    },
    booking: {
      propertyId: "f2000000-0000-0000-0000-000000000951",
      guestBookingId: "book_bank_001",
      bookingReference: "B-BANK-001",
      guestEmail: "guest@example.test",
      guestName: "Ada Guest",
      propertyName: "Hotel Alpenrose",
      checkIn: "2026-09-12",
      checkOut: "2026-09-15",
      totalAmount: "600.00",
      balanceAmount: "200.00",
      currency: "EUR",
      paymentMethod: "bank_transfer",
    },
    ...overrides,
  };
}
