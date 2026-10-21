import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { QuickSetupPreviewCard } from "./QuickSetupPreviewCard";
import { QuickSetupShell } from "./QuickSetupShell";
import { QuickSetupStepLayout, type QuickSetupFooterProps } from "./QuickSetupStepLayout";

vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <span role="img" aria-label={alt} />,
}));

function step(footer: Partial<QuickSetupFooterProps> = {}) {
  return (
    <QuickSetupStepLayout
      title="Your first room and price"
      subtitle="Start with one room type. Add the rest whenever you like."
      footer={{ primaryLabel: "Continue", note: "Saved as you type", ...footer }}
      preview={
        <QuickSetupPreviewCard>
          <p>Hotel Alpenrose</p>
        </QuickSetupPreviewCard>
      }
    >
      <input aria-label="Room type name" defaultValue="Classic Double" />
    </QuickSetupStepLayout>
  );
}

describe("QuickSetupShell (VAY-2247, header C2)", () => {
  it("shows the step over seven segments and a Save & exit link", async () => {
    const onSaveAndExit = vi.fn();
    const renderer = create(
      <QuickSetupShell step={3} onSaveAndExit={onSaveAndExit}>
        {step()}
      </QuickSetupShell>,
    );
    const progress = renderer.root.findByProps({ role: "progressbar" });
    expect(progress.props).toMatchObject({ "aria-valuenow": 3, "aria-valuemax": 7 });
    expect(progress.findAll((node) => node.type === "span")).toHaveLength(7);
    expect(
      progress
        .findAll((node) => node.type === "span")
        .map((node) => (String(node.props.className).includes("bg-primary-600") ? 1 : 0)),
    ).toEqual([1, 1, 1, 0, 0, 0, 0]);
    const exit = renderer.root.findAll(
      (node) => node.type === "button" && node.children.join("") === "Save & exit",
    );
    expect(exit).toHaveLength(1);
    await act(async () => exit[0]!.props.onClick());
    expect(onSaveAndExit).toHaveBeenCalledOnce();
    renderer.unmount();
  });

  it("shows only the logo after setup (no steps, no Save & exit)", () => {
    const markup = renderToStaticMarkup(
      <QuickSetupShell step={null} onSaveAndExit={vi.fn()}>
        <p>You&apos;re live</p>
      </QuickSetupShell>,
    );
    expect(markup).toContain('aria-label="vayada"');
    expect(markup).not.toContain("progressbar");
    expect(markup).not.toContain("Save &amp; exit");
  });

  it("keeps the step within 1 to 7", () => {
    expect(renderToStaticMarkup(<QuickSetupShell step={9}>{null}</QuickSetupShell>)).toContain(
      "Step 7 of 7",
    );
  });
});

describe("QuickSetupStepLayout (VAY-2247, cards)", () => {
  it("puts the title, the form and the preview card on the page, with the footer note on desktop", () => {
    const markup = renderToStaticMarkup(step({ onBack: vi.fn() }));
    expect(markup).toContain('<h1 id="quick-setup-heading"');
    expect(markup).toContain("Your first room and price");
    expect(markup).toContain('aria-label="Room type name"');
    expect(markup).toContain('aria-label="Your booking page, as guests will see it"');
    expect(markup).toContain("Saved as you type");
    // Desktop footer in the form card and the phone bar under the cards: one is hidden at each size.
    expect(markup.match(/>Back</g)).toHaveLength(2);
    expect(markup).toContain('class="hidden lg:block"');
    expect(markup).toContain('class="lg:hidden"');
  });

  it("has no Back on the first step, and the primary button submits the step's form", () => {
    const renderer = create(step({ formId: "quick-setup-form" }));
    const buttons = renderer.root.findAllByType("button");
    expect(buttons.map((button) => button.props.type)).toEqual(["submit", "submit"]);
    expect(buttons.every((button) => button.props.form === "quick-setup-form")).toBe(true);
    renderer.unmount();
  });

  it("shows the busy label and disables the primary button while saving", () => {
    const onPrimary = vi.fn();
    const renderer = create(step({ onPrimary, primaryBusy: true, primaryBusyLabel: "Saving…" }));
    const [desktop] = renderer.root.findAllByType("button");
    expect(desktop!.props).toMatchObject({ type: "button", disabled: true, "aria-busy": true });
    expect(desktop!.children.join("")).toBe("Saving…");
    renderer.unmount();
  });
});
