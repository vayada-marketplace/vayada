import { describe, expect, it } from "vitest";
import type { QueryResultRow } from "pg";

import {
  BOOKING_EMAIL_QUEUE,
  BOOKING_FINAL_CONFIRMATION_EMAIL_JOB_TYPE,
  BOOKING_RESERVED_PENDING_PAYMENT_EMAIL_JOB_TYPE,
  bookingLifecycleEmailJobKey,
  enqueueBookingLifecycleEmailJob,
  type BookingLifecycleEmailInput,
} from "./bookingEmails.js";

describe("booking lifecycle email jobs", () => {
  it("enqueues a bank-transfer reserved-pending-payment email with details and deadline", async () => {
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
      jobKey: bookingLifecycleEmailJobKey("reserved_pending_payment", "book_bank_001"),
    });

    const jobInsert = target.requiredCall("INSERT INTO platform.jobs");
    expect(jobInsert.values?.[1]).toBe(BOOKING_EMAIL_QUEUE);
    expect(jobInsert.values?.[2]).toBe(BOOKING_RESERVED_PENDING_PAYMENT_EMAIL_JOB_TYPE);

    const payload = JSON.parse(String(jobInsert.values?.[8]));
    expect(payload.subject).toContain("reserved pending payment");
    expect(payload.text).toContain("We've reserved your room");
    expect(payload.text).toContain("Payment deadline: 2026-09-02T10:00:00.000Z");
    expect(payload.text).toContain('"iban":"DE89370400440532013000"');
    expect(payload.bankTransferDetails).toMatchObject({
      iban: "DE89370400440532013000",
    });

    expect(target.requiredCall("INSERT INTO platform.domain_events").values?.[1]).toBe(
      "booking.email.reserved_pending_payment_requested",
    );
    expect(target.requiredCall("INSERT INTO platform.product_audit_events").values?.[1]).toBe(
      "booking.email.reserved_pending_payment_requested",
    );
  });

  it("renders the final confirmation email without the removed extra paragraph", async () => {
    const target = createTargetEmailStore();

    await enqueueBookingLifecycleEmailJob(
      target,
      bookingEmailInput({
        kind: "final_confirmation",
      }),
    );

    const jobInsert = target.requiredCall("INSERT INTO platform.jobs");
    expect(jobInsert.values?.[2]).toBe(BOOKING_FINAL_CONFIRMATION_EMAIL_JOB_TYPE);

    const payload = JSON.parse(String(jobInsert.values?.[8]));
    expect(payload.template).toBe("booking_final_confirmation");
    expect(payload.text).toContain("We look forward to welcoming you!");
    expect(payload.text).not.toContain("You can look up your booking anytime");
    expect(payload.text.split("We look forward to welcoming you!")[1]).toBe("");
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
});

type QueryCall = { text: string; values?: readonly unknown[] };

function createTargetEmailStore(): {
  calls: QueryCall[];
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
  requiredCall(fragment: string): QueryCall;
} {
  const calls: QueryCall[] = [];
  const jobs = new Map<string, string>();

  return {
    calls,
    async query<T extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ): Promise<{ rows: T[] }> {
      calls.push({ text, values });
      if (text.includes("INSERT INTO platform.domain_events")) {
        return { rows: [{ eventId: "event_booking_email_001" } as unknown as T] };
      }
      if (text.includes("INSERT INTO platform.jobs")) {
        const jobKey = String(values?.[0]);
        const existingJobId = jobs.get(jobKey);
        if (existingJobId) {
          return { rows: [{ jobId: existingJobId, replay: true } as unknown as T] };
        }
        const jobId = "job_booking_email_001";
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
