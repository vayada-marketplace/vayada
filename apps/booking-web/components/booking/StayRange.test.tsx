import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import StayRange from "./StayRange";

const html = (checkIn: string, checkOut: string, locale?: string) =>
  renderToStaticMarkup(createElement(StayRange, { checkIn, checkOut, locale }));
const text = (markup: string) => markup.replace(/<[^>]+>/g, "");

it("shows a stay as two readable dates that each stay whole", () => {
  const markup = html("2026-11-20", "2026-11-24");
  expect(text(markup)).toBe("Fri, 20 Nov 2026 → Tue, 24 Nov 2026");
  expect(markup.match(/class="whitespace-nowrap"/g)).toHaveLength(2);
  expect(text(html("2026-11-20", "2026-11-24", "de"))).toBe(
    "Fr., 20. Nov. 2026 → Di., 24. Nov. 2026",
  );
});

it("shows a date the guest is still choosing as a dash, not a dangling arrow", () => {
  expect(text(html("2026-11-20", ""))).toBe("Fri, 20 Nov 2026 → —");
});
