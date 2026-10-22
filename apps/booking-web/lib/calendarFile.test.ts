import { describe, expect, it } from "vitest";
import { stayCalendarFile } from "./calendarFile";

describe("stay calendar file", () => {
  const file = stayCalendarFile({
    reference: "VAY-7C2F4A9E1B3D4F6A8C0E2B4D6F8A1C3E",
    title: "Hotel Alpenrose, Zermatt; 3 nights",
    location: "Zermatt",
    checkIn: "2027-03-12",
    checkOut: "2027-03-15",
    notes:
      "Check-in: 15:00\nCheck-out: 11:00\nBooking Reference: VAY-7C2F4A9E1B3D4F6A8C0E2B4D6F8A1C3E",
    now: new Date("2026-10-22T09:30:15.123Z"),
  });
  const lines = file.split("\r\n");

  it("covers the check-in day through the check-out day as one all-day event", () => {
    expect(lines).toContain("DTSTART;VALUE=DATE:20270312");
    expect(lines).toContain("DTEND;VALUE=DATE:20270316");
    expect(lines).toContain("DTSTAMP:20261022T093015Z");
    expect(lines).toContain("UID:VAY-7C2F4A9E1B3D4F6A8C0E2B4D6F8A1C3E@booking.vayada.com");
    expect(file.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(file.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  it("escapes text and folds long lines at 75 octets", () => {
    expect(lines).toContain("SUMMARY:Hotel Alpenrose\\, Zermatt\\; 3 nights");
    for (const line of lines) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    const description = file.slice(file.indexOf("DESCRIPTION:")).split("\r\nTRANSP")[0]!;
    expect(description.replaceAll("\r\n ", "")).toBe(
      "DESCRIPTION:Check-in: 15:00\\nCheck-out: 11:00\\nBooking Reference: VAY-7C2F4A9E1B3D4F6A8C0E2B4D6F8A1C3E",
    );
  });

  it("rolls the end over a month and leaves out an unknown location", () => {
    const lines = stayCalendarFile({
      reference: "VAY-1",
      title: "Stay",
      checkIn: "2027-02-27",
      checkOut: "2027-02-28",
      notes: "Ünïcödé ".repeat(20),
    }).split("\r\n");
    expect(lines).toContain("DTEND;VALUE=DATE:20270301");
    expect(lines.some((line) => line.startsWith("LOCATION:"))).toBe(false);
    for (const line of lines) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
  });
});
