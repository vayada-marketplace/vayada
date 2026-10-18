import { describe, expect, it } from "vitest";

import { createResendBookingEmailDelivery } from "./bookingEmailDelivery.js";
import {
  contactNotificationEmail,
  contactNotificationSender,
  IncompleteNotificationError,
  supportNotificationEmail,
} from "./contactNotificationDelivery.js";

const payload = {
  name: "Ana Host",
  email: "ana@example.com",
  phone: null,
  company: "Casa Ana",
  country: "Portugal",
  userType: "hotel",
  message: "We have 12 rooms.\nCan we talk on Friday?",
};

describe("contact notification email (VAY-2286)", () => {
  it("lists the visitor's details as plain text and answers to the visitor", () => {
    const email = contactNotificationEmail(payload, "2026-10-18T20:00:00.000Z");

    expect(email.subject).toBe("Contact form: Ana Host");
    expect(email.replyTo).toBe("ana@example.com");
    expect(email.text).toBe(
      [
        "New message from the contact form on vayada.com.",
        "",
        "Name: Ana Host",
        "Email: ana@example.com",
        "Phone: -",
        "Company: Casa Ana",
        "Country: Portugal",
        "I am a: Hotel owner or manager",
        "Received: 2026-10-18T20:00:00.000Z",
        "",
        "Message:",
        "We have 12 rooms.\nCan we talk on Friday?",
        "",
        "Reply to this email to answer Ana Host directly.",
      ].join("\n"),
    );
  });

  it("keeps line breaks out of the subject and header-like lines", () => {
    const email = contactNotificationEmail(
      { ...payload, name: "Ana\r\nBcc: x@example.com", company: "Casa\nAna" },
      "2026-10-18T20:00:00.000Z",
    );

    expect(email.subject).toBe("Contact form: Ana Bcc: x@example.com");
    expect(email.text).toContain("Name: Ana Bcc: x@example.com\n");
    expect(email.text).toContain("Company: Casa Ana\n");
  });

  it("drops Reply-To for an unusable address and refuses an emptied job", () => {
    for (const email of ["ana at example", "jörg@münchen.de", 'a"b@example.com', "ana@example"])
      expect(contactNotificationEmail({ ...payload, email }, new Date()).replyTo).toBeUndefined();
    expect(
      contactNotificationEmail({ ...payload, email: "a.b+c@x-y.co.uk" }, new Date()).replyTo,
    ).toBe("a.b+c@x-y.co.uk");
    expect(() => contactNotificationEmail({}, new Date())).toThrow("incomplete");
  });

  it("prints free-text user types as written", () => {
    expect(
      contactNotificationEmail({ ...payload, userType: "constructor" }, new Date()).text,
    ).toContain("I am a: constructor\n");
  });

  it("describes an in-app support request with app, hotel account and page", () => {
    const request = {
      name: "Ben Owner",
      email: "ben@example.com",
      userType: "support",
      message: JSON.stringify({
        kind: "support",
        message: "How do I add a second room?",
        page: "/setup",
        product: "booking",
        userId: "user-1",
        organizationId: "org-1",
        organizationName: "Casa Ana",
      }),
    };

    const email = supportNotificationEmail(request, "2026-10-18T20:00:00.000Z");

    expect(email.subject).toBe("Support request · Booking Admin · Casa Ana");
    expect(email.replyTo).toBe("ben@example.com");
    expect(email.text).toBe(
      [
        "New support request from Booking Admin.",
        "",
        "Hotel: -",
        "Account: Casa Ana",
        "Name: Ben Owner",
        "Email: ben@example.com",
        "Page: /setup",
        "Received: 2026-10-18T20:00:00.000Z",
        "User ID: user-1",
        "Organization ID: org-1",
        "",
        "Message:",
        "How do I add a second room?",
        "",
        "Reply to this email to answer Ben Owner directly.",
      ].join("\n"),
    );
    const bug = supportNotificationEmail(
      {
        ...request,
        message: JSON.stringify({ kind: "bug", message: "Broken", product: "pms", page: "/x" }),
      },
      new Date(),
    );
    expect(bug.subject).toBe("Bug report · PMS · unnamed hotel account");
    // Linked hotels name the request; more than three are counted.
    expect(supportNotificationEmail(request, new Date(), ["Casa Ana"]).subject).toBe(
      "Support request · Booking Admin · Casa Ana",
    );
    expect(supportNotificationEmail(request, new Date(), ["A", "B", "C", "D"]).subject).toBe(
      "Support request · Booking Admin · A, B, C +1",
    );
    expect(
      Array.from(supportNotificationEmail(request, new Date(), ["😀".repeat(200)]).subject).at(-1),
    ).toBe("😀");
    for (const message of ["not json", "null", JSON.stringify({ kind: "bug" })])
      expect(() => supportNotificationEmail({ ...request, message }, new Date())).toThrow(
        IncompleteNotificationError,
      );
  });

  it("sends from the booking address under the contact form name", () => {
    expect(contactNotificationSender("Vayada Bookings <bookings@vayada.com>")).toBe(
      "Vayada contact and support <bookings@vayada.com>",
    );
    expect(contactNotificationSender("bookings@vayada.com")).toBe(
      "Vayada contact and support <bookings@vayada.com>",
    );
  });

  it("passes Reply-To to Resend", async () => {
    const bodies: unknown[] = [];
    const delivery = createResendBookingEmailDelivery({
      apiKey: "re_test",
      from: "Vayada contact and support <bookings@vayada.com>",
      fetch: (async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });

    await delivery.send({
      to: "team@example.test",
      subject: "Contact form: Ana Host",
      text: "Hello",
      idempotencyKey: "platform.contact_submission:abc:v1",
      replyTo: "ana@example.com",
    });

    expect(bodies).toEqual([
      {
        from: "Vayada contact and support <bookings@vayada.com>",
        to: ["team@example.test"],
        subject: "Contact form: Ana Host",
        text: "Hello",
        reply_to: "ana@example.com",
      },
    ]);
  });
});
