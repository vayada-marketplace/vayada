import { expect, it } from "vitest";
import { formatStayDate } from "./index";

it("shows a stay date as the hotel's calendar day, in the page's language", () => {
  expect(formatStayDate("2026-11-13")).toBe("Fri, 13 Nov 2026");
  expect(formatStayDate("2026-11-13", "de")).toBe("Fr., 13. Nov. 2026");
  // Anything that isn't a plain date is shown as it came.
  expect(formatStayDate("")).toBe("");
});
