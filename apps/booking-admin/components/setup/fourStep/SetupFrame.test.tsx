import { act, create, type ReactTestInstance } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { SetupFrame, type SetupFrameProps } from "./SetupFrame";
import { SetupWelcome } from "./SetupWelcome";

vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <span role="img" aria-label={alt} />,
}));

const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");

function frame(overrides: Partial<SetupFrameProps> = {}) {
  return create(
    <SetupFrame
      step="room"
      reached={2}
      propertyName="Lumansa Hiriketiya"
      subStep="Room basics, 1 of 3"
      onSaveAndExit={vi.fn()}
      footer={{ primaryLabel: "Continue", onBack: vi.fn(), onPrimary: vi.fn() }}
      {...overrides}
    >
      <p>Room basics</p>
    </SetupFrame>,
  );
}

describe("SetupFrame (VAY-2451)", () => {
  it("shows the four steps: done ones ticked and open, the current one marked, later ones locked", () => {
    const onPickStep = vi.fn();
    const renderer = frame({ onPickStep });
    const nav = renderer.root.findByProps({ "aria-label": "Setup steps" });
    const steps = nav.findAllByType("button");
    expect(steps.map((step) => textOf(step))).toEqual([
      "Done:Your propertyName, type and logo",
      "Done:Location & contactAddress, contact and socials",
      "3First roomOptional · everything but prices",
      "4Guest paymentsHow guests pay you",
    ]);
    expect(steps.map((step) => step.props.disabled)).toEqual([false, false, true, true]);
    expect(steps[2]!.props["aria-current"]).toBe("step");
    act(() => steps[0]!.props.onClick());
    expect(onPickStep).toHaveBeenCalledWith("property");
    expect(textOf(renderer.root)).toContain("Setting upLumansa Hiriketiya");
    renderer.unmount();
  });

  it("says Step 3 of 4 with the sub-step, over four segments", () => {
    const renderer = frame();
    expect(textOf(renderer.root)).toContain("Step 3 of 4 · Room basics, 1 of 3");
    const bars = renderer.root.findAllByProps({ role: "progressbar" });
    // One beside the step on wide screens, one under the header on phones.
    expect(bars).toHaveLength(2);
    for (const bar of bars) {
      expect(bar.props).toMatchObject({ "aria-valuenow": 3, "aria-valuemax": 4 });
      expect(
        bar
          .findAllByType("span")
          .map((segment) => (String(segment.props.className).includes("bg-primary-600") ? 1 : 0)),
      ).toEqual([1, 1, 1, 0]);
    }
    renderer.unmount();
  });

  it("keeps the footer: why Continue is off, Skip for now and Finish setup", () => {
    const onSkip = vi.fn();
    const renderer = frame({
      footer: {
        primaryLabel: "Finish setup",
        onPrimary: vi.fn(),
        primaryDisabled: true,
        hint: "Add at least one photo to continue",
        onSkip,
      },
    });
    const finish = renderer.root.find(
      (node) => node.type === "button" && textOf(node) === "Finish setup",
    );
    expect(finish.props.disabled).toBe(true);
    // The hint is written once for phones (above) and once for wide screens (beside the button).
    expect(
      renderer.root.findAll(
        (node) => node.type === "p" && textOf(node) === "Add at least one photo to continue",
      ),
    ).toHaveLength(2);
    act(() =>
      renderer.root
        .find((node) => node.type === "button" && textOf(node) === "Skip for now")
        .props.onClick(),
    );
    expect(onSkip).toHaveBeenCalledOnce();
    renderer.unmount();
  });

  it("offers Save & exit, and shows the aside only next to the form", () => {
    const onSaveAndExit = vi.fn();
    const renderer = frame({ onSaveAndExit, aside: <p>Preview</p> });
    act(() =>
      renderer.root
        .find((node) => node.type === "button" && textOf(node) === "Save & exit")
        .props.onClick(),
    );
    expect(onSaveAndExit).toHaveBeenCalledOnce();
    expect(textOf(renderer.root)).toContain("Preview");
    renderer.unmount();
  });
});

describe("SetupWelcome (VAY-2451)", () => {
  it("lists the four steps with their times and starts setup", () => {
    const onStart = vi.fn();
    const renderer = create(<SetupWelcome onStart={onStart} />);
    const text = textOf(renderer.root);
    expect(text).toContain("Welcome to vayada");
    expect(text).toContain("4 short steps, about 9 minutes");
    expect(text).toContain("First roomOptional · everything but prices5 min");
    act(() =>
      renderer.root
        .find((node) => node.type === "button" && textOf(node) === "Start setup")
        .props.onClick(),
    );
    expect(onStart).toHaveBeenCalledOnce();
    renderer.unmount();
  });
});
