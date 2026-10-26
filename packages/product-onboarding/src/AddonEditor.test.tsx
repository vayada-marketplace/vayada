import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { AddonEditor, AddonGuestPreview, emptyAddonValues } from "./AddonEditor";
import { GuestAddonCard, GuestAddonDetail } from "./GuestAddon";

const previewTab = (view: ReactTestRenderer, label: string) =>
  view.root.find(
    (node) => node.props["aria-pressed"] !== undefined && node.children.includes(label),
  );

describe("shared add-on editor", () => {
  it("shows inline errors on submit and leaves the save button enabled", async () => {
    const save = vi.fn();
    let view: ReactTestRenderer;
    await act(async () => {
      view = create(
        <AddonEditor
          initialValues={emptyAddonValues("EUR")}
          currency="EUR"
          editing={false}
          onSave={save}
          onCancel={() => {}}
        />,
      );
    });
    await act(async () => {
      await view!.root.findByType("form").props.onSubmit({ preventDefault() {} });
    });
    expect(save).not.toHaveBeenCalled();
    expect(view!.root.findAllByProps({ role: "alert" })).toHaveLength(2);
    expect(view!.root.findByProps({ type: "submit" }).props.disabled).toBeUndefined();
    expect(view!.root.findAllByProps({ name: "addon-pricing-model" })).toHaveLength(4);
  });

  it("retains photo order, changes cover, removes photos, and inherits property currency", async () => {
    const save = vi.fn();
    const photos = Array.from({ length: 5 }, (_, i) => ({
      imageUrl: `https://media.test/${i}`,
      mediaObjectId: `media-${i}`,
      isCover: i === 0,
    }));
    let view: ReactTestRenderer;
    await act(async () => {
      view = create(
        <AddonEditor
          initialValues={{ ...emptyAddonValues("USD"), name: "Breakfast", price: "15.00", photos }}
          currency="EUR"
          editing
          onSave={save}
          onCancel={() => {}}
        />,
      );
    });
    expect(view!.root.findAllByProps({ "aria-label": "Add photos" })).toHaveLength(0);
    await act(async () => {
      view!.root.findByProps({ "aria-label": "Set photo 3 as cover" }).props.onClick();
    });
    await act(async () => {
      view!.root.findByProps({ "aria-label": "Remove photo 2" }).props.onClick();
    });
    await act(async () => {
      view!.root.findAllByProps({ name: "addon-pricing-model" })[3].props.onChange();
    });
    await act(async () => {
      await view!.root.findByType("form").props.onSubmit({ preventDefault() {} });
    });
    const saved = save.mock.calls[0][0];
    expect(saved.currency).toBe("EUR");
    expect(saved.perPerson && saved.perNight).toBe(true);
    expect(saved.photos.map((p: { mediaObjectId: string }) => p.mediaObjectId)).toEqual([
      "media-0",
      "media-2",
      "media-3",
      "media-4",
    ]);
    expect(saved.photos.filter((p: { isCover: boolean }) => p.isCover)).toEqual([
      { ...photos[2], isCover: true },
    ]);
    await act(async () => {
      view!.unmount();
    });
    await act(async () => {
      view = create(
        <AddonEditor
          initialValues={saved}
          currency="EUR"
          editing
          onSave={save}
          onCancel={() => {}}
        />,
      );
    });
    expect(
      view!.root.findByProps({ "aria-label": "Set photo 2 as cover" }).props["aria-pressed"],
    ).toBe(true);
  });
});

it("picks a category chip, labels the price by pricing model and opens More options on errors", async () => {
  const save = vi.fn();
  let view: ReactTestRenderer;
  await act(async () => {
    view = create(
      <AddonEditor
        initialValues={{ ...emptyAddonValues("EUR"), name: "Breakfast", price: "15.00" }}
        currency="EUR"
        editing={false}
        onSave={save}
        onCancel={() => {}}
      />,
    );
  });
  const text = () => JSON.stringify(view!.toJSON());
  expect(view!.root.findByType("details").props.open).toBe(false);
  expect(view!.root.findAllByProps({ name: "addon-category" })).toHaveLength(5);
  await act(async () => {
    view!.root.findAllByProps({ name: "addon-category" })[0].props.onChange();
    view!.root.findAllByProps({ name: "addon-pricing-model" })[3].props.onChange();
  });
  expect(
    view!.root.findAllByProps({ "aria-label": "Price per guest per night (EUR) *" }),
  ).toHaveLength(1);
  expect(text()).toContain("90.00");
  await act(async () => {
    view!.root
      .findByProps({ "aria-label": "Max quantity" })
      .props.onChange({ target: { value: "0" } });
  });
  await act(async () => {
    await view!.root.findByType("form").props.onSubmit({ preventDefault() {} });
  });
  expect(save).not.toHaveBeenCalled();
  expect(view!.root.findByType("details").props.open).toBe(true);
  await act(async () => {
    view!.root
      .findByProps({ "aria-label": "Max quantity" })
      .props.onChange({ target: { value: "2" } });
  });
  await act(async () => {
    await view!.root.findByType("form").props.onSubmit({ preventDefault() {} });
  });
  expect(save.mock.calls[0][0]).toMatchObject({
    category: "dining",
    perPerson: true,
    perNight: true,
    maxQuantity: "2",
  });
});

it("previews the add-on with the booking page's own card as the host types (VAY-2231)", async () => {
  let view: ReactTestRenderer;
  await act(async () => {
    view = create(
      <AddonEditor
        initialValues={{ ...emptyAddonValues("USD"), price: "30.00", perPerson: true }}
        currency="USD"
        editing={false}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
  });
  const card = () => view!.root.findByType(GuestAddonCard).props;
  expect(card()).toMatchObject({
    name: "Untitled add-on",
    description: "",
    photo: null,
    price: "US$30",
    unit: "/ person",
  });
  const name = view!.root.findAllByType("input").find((i) => i.props["aria-label"] === "Name *")!;
  await act(async () => {
    name.props.onChange({ target: { value: "Airport transfer" } });
  });
  expect(card().name).toBe("Airport transfer");
});

it("offers the fixed lead times and shows the guests' notice in the preview (VAY-2232)", async () => {
  const save = vi.fn();
  let view: ReactTestRenderer;
  await act(async () => {
    view = create(
      <AddonEditor
        initialValues={{
          ...emptyAddonValues("EUR"),
          name: "Airport transfer",
          price: "30.00",
          leadTimeHours: "24",
        }}
        currency="EUR"
        editing
        onSave={save}
        onCancel={() => {}}
      />,
    );
  });
  const text = () => JSON.stringify(view!.toJSON());
  const select = () =>
    view!.root.findAllByType("select").find((s) => s.findAllByType("option").length === 6)!;
  // A saved lead time opens More options.
  expect(view!.root.findByType("details").props.open).toBe(true);
  expect(select().props.value).toBe("24");
  expect(
    select()
      .findAllByType("option")
      .map((o) => o.props.children),
  ).toEqual(["No lead time", "12 hours", "24 hours", "2 days", "3 days", "1 week"]);
  // VAY-2231: the guests' notice is one of the details' facts.
  await act(async () => {
    previewTab(view!, "Detail view").props.onClick();
  });
  expect(text()).toContain("Needs 24 hours’ notice");
  await act(async () => {
    select().props.onChange({ target: { value: "168" } });
  });
  expect(text()).toContain("Needs 1 week’s notice");
  await act(async () => {
    await view!.root.findByType("form").props.onSubmit({ preventDefault() {} });
  });
  expect(save.mock.calls[0][0].leadTimeHours).toBe("168");
  await act(async () => {
    select().props.onChange({ target: { value: "" } });
  });
  expect(text()).not.toContain("notice");
});

it("shows a lead time typed before the fixed choices until one is picked (VAY-2232)", async () => {
  const save = vi.fn();
  let view: ReactTestRenderer;
  await act(async () => {
    view = create(
      <AddonEditor
        initialValues={{
          ...emptyAddonValues("EUR"),
          name: "Airport transfer",
          price: "30.00",
          legacyLeadTime: "10h",
        }}
        currency="EUR"
        editing
        onSave={save}
        onCancel={() => {}}
      />,
    );
  });
  const select = () =>
    view!.root.findAllByType("select").find((s) => s.findAllByType("option").length === 7)!;
  expect(select().props.value).toBe("typed");
  const typed = select().findAllByType("option")[0]!;
  expect(typed.props).toMatchObject({
    value: "typed",
    disabled: true,
    children: "10h (typed earlier)",
  });
  // Choosing "No lead time" is a choice too: the typed text goes.
  await act(async () => {
    select().props.onChange({ target: { value: "" } });
  });
  await act(async () => {
    await view!.root.findByType("form").props.onSubmit({ preventDefault() {} });
  });
  expect(save.mock.calls[0][0]).toMatchObject({ leadTimeHours: "", legacyLeadTime: "" });
});

it("switches the preview to the details guests open, with every fact the host filled in", async () => {
  const photos = [0, 1, 2].map((i) => ({
    imageUrl: `https://media.test/${i}`,
    mediaObjectId: `media-${i}`,
    isCover: i === 1,
  }));
  let view: ReactTestRenderer;
  await act(async () => {
    view = create(
      <AddonEditor
        initialValues={{
          ...emptyAddonValues("EUR"),
          name: "Old town walk",
          category: "experience",
          price: "25",
          perPerson: true,
          duration: "2 hours",
          location: " ",
          maxGuests: "8",
          photos,
        }}
        currency="EUR"
        editing
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
  });
  expect(previewTab(view!, "Checkout list").props["aria-pressed"]).toBe(true);
  expect(view!.root.findAllByType(GuestAddonDetail)).toHaveLength(0);
  // The card's own "See details" opens the details too.
  await act(async () => {
    view!.root.findByType(GuestAddonCard).props.onOpenDetails();
  });
  expect(previewTab(view!, "Detail view").props["aria-pressed"]).toBe(true);
  expect(view!.root.findByType(GuestAddonDetail).props).toMatchObject({
    name: "Old town walk",
    category: "Experiences",
    photos: ["https://media.test/1", "https://media.test/0", "https://media.test/2"],
    facts: { duration: "2 hours", location: null, guests: "Up to 8 guests", notice: null },
    price: "€25",
    unit: "/ person",
    size: "compact",
  });
});

it("previews a saved add-on as guests see it, with a way to edit it", async () => {
  const edit = vi.fn();
  const close = vi.fn();
  let view: ReactTestRenderer;
  await act(async () => {
    view = create(
      <AddonGuestPreview
        values={{ ...emptyAddonValues("EUR"), name: "Airport transfer", price: "45.00" }}
        currency="EUR"
        onEdit={edit}
        onClose={close}
      />,
    );
  });
  const text = JSON.stringify(view!.toJSON());
  expect(text).toContain("Guest preview · Airport transfer");
  expect(view!.root.findByType(GuestAddonDetail).props.price).toBe("€45");
  const button = (label: string) =>
    view!.root.find((node) => node.type === "button" && node.children.includes(label));
  button("Edit add-on").props.onClick();
  button("Done").props.onClick();
  expect(edit).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
});
