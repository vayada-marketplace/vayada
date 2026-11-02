import { describe, expect, it } from "vitest";
import en from "../../../messages/en.json";
import {
  arrivalDay,
  checkForm,
  choicesFromForm,
  formFromChoices,
  isDirty,
  saveStatus,
  type ArrivalForm,
} from "./arrivalTimesForm";
import { daySummary, timeZoneLabel } from "./arrivalTimesText";

const choices = {
  defaultGuestLanguage: "en" as const,
  childrenEnabled: true,
  adultAgeThreshold: 12,
  phoneRequired: true,
  arrivalTimeEnabled: false,
  specialRequestsEnabled: true,
  checkInTime: "15:00",
  checkOutTime: "11:00",
};
const t = (key: string, params: Record<string, string | number> = {}) =>
  Object.entries(params).reduce(
    (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
    (en as Record<string, string>)[key] ?? key,
  );
const form = (patch: Partial<ArrivalForm> = {}) => ({ ...formFromChoices(choices), ...patch });

describe("check-in & check-out form", () => {
  it("round-trips the guest rules, sending a window only while it is switched on", () => {
    expect(choicesFromForm(formFromChoices(choices))).toEqual(choices);
    const windows = { ...choices, checkInUntil: "00:00", checkOutFrom: "07:00" };
    expect(choicesFromForm(formFromChoices(windows))).toEqual(windows);
    // Switched off, the time stays in the form but isn't saved.
    expect(choicesFromForm(form({ checkInUntil: "23:00" }))).toEqual(choices);
    expect(choicesFromForm(form({ checkInUntilOn: true, checkInUntil: "23:00" }))).toEqual({
      ...choices,
      checkInUntil: "23:00",
    });
  });

  it("starts an open draft with nothing chosen and 22:00 / 07:00 ready behind the switches", () => {
    const open = formFromChoices({ checkInTime: "14:00", checkOutTime: "12:00" });
    expect(open).toMatchObject({
      checkInTime: "14:00",
      checkOutTime: "12:00",
      language: "",
      children: "",
      adultAge: "",
      checkInUntilOn: false,
      checkInUntil: "22:00",
      checkOutFrom: "07:00",
      phoneRequired: true,
      arrivalTimeEnabled: false,
      specialRequestsEnabled: true,
    });
    expect(choicesFromForm(open)).toBeNull();
    expect(checkForm(open)).toMatchObject({ required: 5, done: 2, missing: 3 });
    expect(checkForm(formFromChoices({}))).toMatchObject({ done: 0, missing: 5 });
  });

  it("asks for the adult age only while children are welcome, and keeps an adults-only hotel's age", () => {
    const adultsOnly = form({ children: "no", adultAge: "" });
    expect(checkForm(adultsOnly)).toMatchObject({ required: 4, done: 4, missing: 0, errors: {} });
    expect(choicesFromForm(adultsOnly)).toMatchObject({
      childrenEnabled: false,
      adultAgeThreshold: null,
    });
    expect(choicesFromForm(form({ children: "no" }))).toMatchObject({ adultAgeThreshold: 12 });
    expect(checkForm(form({ adultAge: "" }))).toMatchObject({ required: 5, missing: 1 });
  });

  it("accepts only the adult ages the guest rules accept, 1 to 21", () => {
    for (const age of ["1", "18", "21", " 16 "])
      expect(checkForm(form({ adultAge: age })).errors).toEqual({});
    for (const age of ["0", "22", "99", "1.5", "abc", "-3"]) {
      expect(checkForm(form({ adultAge: age })).errors).toEqual({ adultAge: { kind: "age" } });
      expect(choicesFromForm(form({ adultAge: age }))).toBeNull();
    }
  });

  it("checks each window against itself, as the API does, allowing midnight as the latest check-in", () => {
    const errors = (patch: Partial<ArrivalForm>) => checkForm(form(patch)).errors;
    expect(errors({ checkInUntilOn: true, checkInUntil: "" })).toEqual({
      checkInUntil: { kind: "pickTime" },
    });
    expect(errors({ checkInUntilOn: true, checkInUntil: "14:00" })).toEqual({
      checkInUntil: { kind: "laterThan", time: "15:00" },
    });
    expect(errors({ checkInUntilOn: true, checkInUntil: "15:00" })).toEqual({
      checkInUntil: { kind: "laterThan", time: "15:00" },
    });
    expect(errors({ checkInUntilOn: true, checkInUntil: "00:00" })).toEqual({});
    expect(choicesFromForm(form({ checkInUntilOn: true, checkInUntil: "00:00" }))).toMatchObject({
      checkInUntil: "00:00",
    });
    expect(errors({ checkOutFromOn: true, checkOutFrom: "11:00" })).toEqual({
      checkOutFrom: { kind: "earlierThan", time: "11:00" },
    });
    expect(errors({ checkOutFromOn: true, checkOutFrom: "" })).toEqual({
      checkOutFrom: { kind: "pickTime" },
    });
    // Check-in and check-out happen on different days: a late check-out next to an early check-in is allowed.
    expect(errors({ checkInTime: "10:00", checkOutTime: "14:00" })).toEqual({});
  });

  it("shows the most urgent of the six save states", () => {
    const saved = form();
    const status = (current: ArrivalForm, confirmed = true, justSaved = false) =>
      saveStatus(checkForm(current), isDirty(current, saved), confirmed, justSaved);
    expect(status(form({ language: "" }))).toBe("missing");
    expect(status(form({ language: "", adultAge: "40" }))).toBe("missing");
    expect(status(form({ adultAge: "40" }))).toBe("invalid");
    expect(status(form({ checkInTime: "16:00" }))).toBe("dirty");
    expect(status(saved, false)).toBe("ready");
    expect(status(saved, true, true)).toBe("saved");
    expect(status(saved)).toBe("clean");
  });

  it("ignores what wouldn't be saved when telling unsaved changes", () => {
    const saved = form();
    expect(isDirty(form({ checkInUntil: "23:00" }), saved)).toBe(false);
    expect(isDirty(form({ checkInUntilOn: true }), saved)).toBe(true);
    const adultsOnly = form({ children: "no" });
    expect(isDirty({ ...adultsOnly, adultAge: "" }, adultsOnly)).toBe(false);
  });

  it("draws the day and says it in a sentence, with the turnover between the two windows", () => {
    const day = (patch: Partial<ArrivalForm>) => arrivalDay(form(patch), checkForm(form(patch)));
    expect(day({})).toEqual({
      checkOut: { start: 0, end: 660, from: null, by: "11:00" },
      checkIn: { start: 900, end: 1440, from: "15:00", until: null },
      turnover: 240,
    });
    expect(daySummary(t, day({}))).toBe(
      "Guests check out by 11:00 and check in from 15:00. That leaves 4 h to turn the room over.",
    );
    expect(
      daySummary(
        t,
        day({
          checkInTime: "14:30",
          checkInUntilOn: true,
          checkInUntil: "00:00",
          checkOutFromOn: true,
          checkOutFrom: "07:00",
        }),
      ),
    ).toBe(
      "Guests check out between 07:00 and 11:00 and check in between 14:30 and midnight. That leaves 3 h 30 min to turn the room over.",
    );
    expect(day({ checkInUntilOn: true, checkInUntil: "00:00" }).checkIn?.end).toBe(1440);
    // A window still wrong isn't drawn.
    expect(day({ checkInUntilOn: true, checkInUntil: "14:00" }).checkIn?.until).toBeNull();
    const overlap = day({ checkInTime: "11:00", checkOutTime: "12:00" });
    expect(overlap.turnover).toBe(-60);
    expect(daySummary(t, overlap)).toBe("Guests check out by 12:00 and check in from 11:00.");
    expect(daySummary(t, day({ checkOutTime: "" }))).toBe(
      "Set both times to see your day at a glance.",
    );
  });

  it("names the property's time zone with its offset, and nothing for an unknown one", () => {
    const november = new Date("2026-11-02T12:00:00Z");
    expect(timeZoneLabel("Asia/Makassar", "en", november)).toBe("Central Indonesia Time (UTC+8)");
    expect(timeZoneLabel("Europe/Berlin", "en", november)).toBe(
      "Central European Standard Time (UTC+1)",
    );
    expect(timeZoneLabel("", "en")).toBeNull();
    expect(timeZoneLabel("Not/AZone", "en")).toBeNull();
  });
});
