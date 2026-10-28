import { act, create } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import {
  GuestAddonCard,
  GuestAddonDayChips,
  GuestAddonDetail,
  GuestAddonScheduledLine,
  formatGuestPrice,
  guestAddonUnit,
} from "./GuestAddon";

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

it("shows the details' photos with arrows and dots only when there are several", async () => {
  const detail = (photos: string[]) =>
    create(
      <GuestAddonDetail
        name="Old town walk"
        category="Experiences"
        photos={photos}
        facts={{ duration: "2 hours", location: null, guests: "Up to 8 guests" }}
        description={"A walk.\nWith coffee."}
        price="€25"
        unit="/ person"
        action={<button type="button">Add</button>}
        note={{ text: "Needs 24 hours’ notice, so it can’t be added to this stay.", warning: true }}
      />,
    );
  const one = detail(["https://cdn.vayada.com/1.jpg"]);
  expect(one.root.findAllByType("img")).toHaveLength(1);
  expect(one.root.findAllByProps({ "aria-label": "Next photo" })).toHaveLength(0);
  expect(JSON.stringify(one.toJSON())).toContain("2 hours");
  expect(one.root.findAllByType("li")).toHaveLength(2);
  expect(one.root.findByProps({ "aria-live": "polite" }).props.className).toContain("amber");
  const none = detail([]);
  expect(none.root.findAllByType("img")).toHaveLength(0);
  const three = detail(["a.jpg", "b.jpg", "c.jpg"].map((n) => `https://cdn.vayada.com/${n}`));
  const dots = () =>
    three.root
      .findAllByType("button")
      .filter((b) => String(b.props["aria-label"]).startsWith("Show photo"));
  expect(dots().map((dot) => dot.props["aria-current"])).toEqual([true, false, false]);
  await act(async () => {
    three.root.findByProps({ "aria-label": "Previous photo" }).props.onClick();
  });
  expect(dots().map((dot) => dot.props["aria-current"])).toEqual([false, false, true]);
  await act(async () => {
    three.root.findByProps({ "aria-label": "Show photo 2" }).props.onClick();
  });
  expect(dots().map((dot) => dot.props["aria-current"])).toEqual([false, true, false]);
});

it("opens the details from the card's photo, name and See details", () => {
  const open = vi.fn();
  const card = create(
    <GuestAddonCard
      name="Old town walk"
      description="Two hours."
      photo={null}
      price="€25"
      unit="/ person"
      action={null}
      onOpenDetails={open}
    />,
  );
  card.root.findByType("h3").props.onClick();
  card.root.findByType("button").props.onClick();
  expect(card.root.findByType("button").children).toContain("See details");
  expect(open).toHaveBeenCalledTimes(2);
});

it("shows when an added extra happens: a line, or the days to pick (VAY-2391)", async () => {
  const line = create(
    <GuestAddonScheduledLine line="Tue 3 Nov · your arrival day" sub="Scheduled automatically" />,
  );
  expect(JSON.stringify(line.toJSON())).toContain("Tue 3 Nov · your arrival day");
  const days = [
    { date: "2026-11-03", weekday: "Tue", day: "3 Nov" },
    { date: "2026-11-04", weekday: "Wed", day: "4 Nov" },
  ];
  const pick = vi.fn();
  const chips = create(
    <GuestAddonDayChips
      legend="Choose a day to continue"
      attention
      days={days}
      selected="2026-11-04"
      onPick={pick}
      dayLabel={(weekday, day) => `Sunset Dinner on ${weekday} ${day}`}
    />,
  );
  const buttons = chips.root.findAllByType("button");
  expect(buttons.map((button) => button.props["aria-pressed"])).toEqual([false, true]);
  expect(buttons[0].props["aria-label"]).toBe("Sunset Dinner on Tue 3 Nov");
  expect(chips.root.findByType("legend").props.className).toContain("text-amber-700");
  await act(async () => buttons[0].props.onClick());
  expect(pick).toHaveBeenCalledWith("2026-11-03");
  // Without onPick (Booking Admin's preview) the chips aren't buttons.
  const preview = create(<GuestAddonDayChips legend="Which day?" days={days} selected={null} />);
  expect(preview.root.findAllByType("button")).toHaveLength(0);
});
