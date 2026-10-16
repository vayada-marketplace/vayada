import { expect, it } from "vitest";
import { formatStayDate, formatTimeZoneName } from "./index";

it("shows a stay date as the hotel's calendar day, in the page's language", () => {
  expect(formatStayDate("2026-11-13")).toBe("Fri, 13 Nov 2026");
  expect(formatStayDate("2026-11-13", "de")).toBe("Fr., 13. Nov. 2026");
  // Anything that isn't a plain date is shown as it came.
  expect(formatStayDate("")).toBe("");
});

it("names the hotel's time zone in the page's language", () => {
  expect(formatTimeZoneName("Europe/Zurich")).toBe("Central European Time");
  expect(formatTimeZoneName("Europe/Zurich", "de")).toBe("Mitteleuropäische Zeit");
  expect(formatTimeZoneName("UTC")).toBe("UTC");
  expect(formatTimeZoneName("Etc/UTC", "de")).toBe("UTC");
  for (const alias of ["Etc/UCT", "Zulu", "Etc/Universal", "GMT0", "", null, undefined]) {
    expect(formatTimeZoneName(alias)).toBe("UTC");
  }
  // A zone the browser doesn't know is shown as it came.
  expect(formatTimeZoneName("Mars/Olympus_Mons")).toBe("Mars/Olympus_Mons");
});
