import { describe, expect, it } from "vitest";
import { birthDateInput, birthDateText, parseBirthDate } from "./birthDate";

describe("typed dates of birth (VAY-2418)", () => {
  it("adds the separators while typing and drops anything but digits", () => {
    expect(birthDateInput("2")).toBe("2");
    expect(birthDateInput("2306")).toBe("23 / 06");
    expect(birthDateInput("23/06/1912")).toBe("23 / 06 / 1912");
    expect(birthDateInput("23 / 06 / 19125")).toBe("23 / 06 / 1912");
    // Deleting the last digit after a separator drops the separator too.
    expect(birthDateInput("23 / 06 / ")).toBe("23 / 06");
  });

  it("shows a saved date day first", () => {
    expect(birthDateText("1912-06-23")).toBe("23 / 06 / 1912");
    expect(birthDateText("")).toBe("");
  });

  it("reads only real past dates from 1900 on", () => {
    const today = "2026-08-15";
    expect(parseBirthDate("23 / 06 / 1912", today)).toBe("1912-06-23");
    expect(parseBirthDate("", today)).toBe("");
    expect(parseBirthDate("23 / 06", today)).toBeNull();
    expect(parseBirthDate("31 / 02 / 1990", today)).toBeNull();
    expect(parseBirthDate("01 / 13 / 1990", today)).toBeNull();
    expect(parseBirthDate("31 / 12 / 1899", today)).toBeNull();
    expect(parseBirthDate("16 / 08 / 2026", today)).toBeNull();
    expect(parseBirthDate("15 / 08 / 2026", today)).toBe("2026-08-15");
  });
});
