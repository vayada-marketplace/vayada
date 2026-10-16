import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { AddonEditor, emptyAddonValues } from "./AddonEditor";

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
