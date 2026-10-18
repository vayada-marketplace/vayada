import { describe, expect, it } from "vitest";

import { createResendBookingEmailDelivery } from "./bookingEmailDelivery.js";
import {
  contactNotificationEmail,
  contactNotificationSender,
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
    expect(
      contactNotificationEmail({ ...payload, email: "ana at example" }, new Date()).replyTo,
    ).toBeUndefined();
    expect(() => contactNotificationEmail({}, new Date())).toThrow("incomplete");
  });

  it("sends from the booking address under the contact form name", () => {
    expect(contactNotificationSender("Vayada Bookings <bookings@vayada.com>")).toBe(
      "vayada.com contact form <bookings@vayada.com>",
    );
    expect(contactNotificationSender("bookings@vayada.com")).toBe(
      "vayada.com contact form <bookings@vayada.com>",
    );
  });

  it("passes Reply-To to Resend", async () => {
    const bodies: unknown[] = [];
    const delivery = createResendBookingEmailDelivery({
      apiKey: "re_test",
      from: "vayada.com contact form <bookings@vayada.com>",
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
        from: "vayada.com contact form <bookings@vayada.com>",
        to: ["team@example.test"],
        subject: "Contact form: Ana Host",
        text: "Hello",
        reply_to: "ana@example.com",
      },
    ]);
  });
});
