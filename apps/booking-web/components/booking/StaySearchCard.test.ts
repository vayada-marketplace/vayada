import { expect, it } from "vitest";
import { phoneStayDate } from "./StaySearchCard";

// VAY-2494: the phone's dates row, "Fri 13 Nov → Sat 14 Nov" on one line at 390px.
it("leaves the year out for a stay this year and keeps it for another year", () => {
  expect(phoneStayDate("2026-11-13", "en", 2026)).toBe("Fri 13 Nov");
  expect(phoneStayDate("2027-01-01", "en", 2026)).toBe("Fri, 1 Jan 2027");
  expect(phoneStayDate("2026-11-13", "de", 2026)).toBe("Fr., 13. Nov.");
});

it("shows the stay's calendar day whatever the guest's time zone", () => {
  const zone = process.env.TZ;
  try {
    for (const tz of ["America/Los_Angeles", "Pacific/Kiritimati"]) {
      process.env.TZ = tz;
      expect(phoneStayDate("2026-11-13", "en", 2026)).toBe("Fri 13 Nov");
    }
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});
