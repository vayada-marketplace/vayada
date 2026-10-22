import { create } from "react-test-renderer";
import { expect, it } from "vitest";
import { GuestAddonCard, formatGuestPrice, guestAddonUnit } from "./GuestAddon";

it("formats prices and units the way the booking page does", () => {
  expect(formatGuestPrice(25, "EUR")).toBe("€25");
  expect(formatGuestPrice(610.25, "EUR")).toBe("€610.25");
  expect(formatGuestPrice(30, "USD")).toBe("US$30");
  expect(formatGuestPrice(30, "??")).toBe("?? 30");
  expect(
    [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ].map(([perPerson, perNight]) => guestAddonUnit(perPerson!, perNight!)),
  ).toEqual(["/ stay", "/ person", "/ night", "/ person / night"]);
});

it("draws the photo through the caller and leaves out what the hotel didn't fill in", () => {
  const card = (props: Partial<Parameters<typeof GuestAddonCard>[0]>) =>
    JSON.stringify(
      create(
        <GuestAddonCard
          name="Old town walk"
          description=""
          photo={null}
          price={null}
          unit="/ person"
          action={<button type="button">Add</button>}
          {...props}
        />,
      ).toJSON(),
    );
  const bare = card({});
  expect(bare).toContain("Old town walk");
  expect(bare).not.toContain("/ person");
  expect(bare).not.toContain("line-clamp-2");
  expect(bare).not.toContain('"img"');
  const full = card({
    description: "Two hours with a local guide.",
    photo: "https://cdn.vayada.com/walk.jpg",
    price: "€25",
    tone: "chosen",
    renderPhoto: (src) => <img src={src} data-renderer="caller" alt="" />,
    children: <p>Which day?</p>,
  });
  expect(full).toContain("caller");
  expect(full).toContain("€25");
  expect(full).toContain("/ person");
  expect(full).toContain("Two hours with a local guide.");
  expect(full).toContain("border-primary-500");
  expect(full).toContain("Which day?");
});
