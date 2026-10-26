import { expect, it } from "vitest";
import { extraAmountMinor } from "./bookingExtrasRequests.js";

it("prices an extra for the whole stay as the quote does (VAY-2360)", () => {
  const stay = { guests: 2, nights: 3 };
  expect(extraAmountMinor("2500", "per_stay", stay)).toBe("2500");
  expect(extraAmountMinor("1200", "per_night", stay)).toBe("3600");
  expect(extraAmountMinor("1200", "per_guest", stay)).toBe("2400");
  expect(extraAmountMinor("1200", "per_guest_night", stay)).toBe("7200");
});
