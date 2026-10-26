import { afterEach, describe, expect, it, vi } from "vitest";

import de from "@/messages/de.json";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import fr from "@/messages/fr.json";
import id from "@/messages/id.json";
import { ApiError, bookingWebPublic } from "@/services/api/client";
import { guestError, isLastingRefusal } from "./guestError";

/** What booking-web's client throws for one API answer. */
async function failure(status: number, body: unknown): Promise<ApiError> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      typeof body === "string" ? new Response(body, { status }) : Response.json(body, { status }),
    ),
  );
  const error = await bookingWebPublic.post("/api/booking-web/x", {}).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

const refusal = (message: string, code?: string) => ({
  statusCode: 409,
  error: "Conflict",
  message,
  ...(code ? { code } : {}),
});

afterEach(() => vi.unstubAllGlobals());

describe("API client error message (VAY-2308)", () => {
  it("keeps the API's own 4xx reason instead of the generic text", async () => {
    const error = await failure(
      409,
      refusal(
        "This booked rate is non-refundable and cannot be cancelled online.",
        "BOOKING_CANCEL_NON_REFUNDABLE",
      ),
    );
    expect(error.message).toBe(
      "This booked rate is non-refundable and cannot be cancelled online.",
    );
    expect(error.status).toBe(409);
    expect(error.detail).toMatchObject({ code: "BOOKING_CANCEL_NON_REFUNDABLE" });
  });

  it("still reads the old {detail} shape", async () => {
    expect((await failure(409, { detail: "Fee changed." })).message).toBe("Fee changed.");
  });

  it.each([
    ["a 5xx", 500, { statusCode: 500, error: "Internal Server Error", message: "relation x" }],
    ["a 503", 503, { statusCode: 503, message: "Database is temporarily unavailable" }],
    [
      "Fastify's validation",
      400,
      { statusCode: 400, code: "FST_ERR_VALIDATION", message: "body/guestEmail must be string" },
    ],
    [
      "an unknown route",
      404,
      { statusCode: 404, message: "Route POST:/api/booking-web/x not found" },
    ],
    ["an empty message", 409, { statusCode: 409, message: " " }],
    ["a non-JSON body", 502, "<html>Bad Gateway</html>"],
  ])("never shows %s message", async (_name, status, body) => {
    expect((await failure(status, body)).message).toBe("Something went wrong. Please try again.");
  });
});

describe("guestError", () => {
  it.each([
    ["BOOKING_CANCEL_NON_REFUNDABLE", "cancelNonRefundable"],
    ["BOOKING_CANCEL_DEADLINE_PASSED", "cancelDeadlinePassed"],
    ["BOOKING_CANCEL_CHECK_IN_PASSED", "cancelCheckInPassed"],
    ["BOOKING_CANCEL_NOT_ONLINE", "cancelNotOnline"],
    ["BOOKING_CANCEL_FEE_CHANGED", "cancelFeeChanged"],
    ["BOOKING_WITHDRAW_NOT_ONLINE", "withdrawNotOnline"],
    ["BOOKING_NOT_CHANGEABLE", "bookingNotChangeable"],
    ["busy_try_again", "busyTryAgain"],
  ])("translates %s", async (code, key) => {
    expect(guestError(await failure(409, refusal("English reason.", code)))).toEqual({ key });
  });

  it("shows an uncoded 4xx reason as the API wrote it", async () => {
    const error = await failure(409, refusal("A booking change request is already pending."));
    expect(guestError(error)).toEqual({
      message: "A booking change request is already pending.",
    });
    expect(guestError(await failure(409, refusal("Other.", "SOMETHING_NEW")))).toEqual({
      message: "Other.",
    });
  });

  it("leaves 5xx, network and unreadable failures to the page's own text", async () => {
    expect(
      guestError(await failure(500, { message: "boom", code: "BOOKING_NOT_CHANGEABLE" })),
    ).toBe(null);
    expect(guestError(await failure(400, { code: "FST_ERR_VALIDATION", message: "x" }))).toBe(null);
    expect(guestError(new TypeError("Failed to fetch"))).toBe(null);
    expect(guestError(new Error("Something else"))).toBe(null);
  });
});

describe("isLastingRefusal", () => {
  it("is a 409 the API will repeat, never a busy answer, outage or other status", async () => {
    expect(isLastingRefusal(await failure(409, refusal("No.", "BOOKING_CANCEL_NOT_ONLINE")))).toBe(
      true,
    );
    expect(isLastingRefusal(await failure(409, refusal("No.")))).toBe(true);
    expect(isLastingRefusal(await failure(409, refusal("Busy.", "busy_try_again")))).toBe(false);
    expect(isLastingRefusal(await failure(503, { message: "down" }))).toBe(false);
    expect(isLastingRefusal(await failure(404, { message: "Booking not found." }))).toBe(false);
    expect(isLastingRefusal(new TypeError("Failed to fetch"))).toBe(false);
  });
});

it("every locale has every guest error text and the contact button", () => {
  const keys = Object.keys(en.guestErrors).sort();
  expect(keys).toContain("somethingWentWrong");
  for (const messages of [de, en, es, fr, id]) {
    expect(Object.keys(messages.guestErrors).sort()).toEqual(keys);
    for (const text of Object.values(messages.guestErrors)) expect(text.trim()).not.toBe("");
    expect(messages.myBooking.contactHotel.trim()).not.toBe("");
  }
});
