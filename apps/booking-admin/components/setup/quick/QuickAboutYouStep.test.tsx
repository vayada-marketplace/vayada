import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { QuickAboutYouStep, aboutYouErrors } from "./QuickAboutYouStep";

vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <span role="img" aria-label={alt} />,
}));

const base = {
  email: "clara@example.com",
  organizationName: "Alpenrose Hotel Group",
  onSaveAndExit: vi.fn(),
};

function inputs(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType("input");
}

async function type(renderer: ReactTestRenderer, index: number, value: string) {
  await act(async () => inputs(renderer)[index]!.props.onChange({ target: { value } }));
}

async function submit(renderer: ReactTestRenderer) {
  await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
}

describe("QuickAboutYouStep (VAY-2247 step 1)", () => {
  it("shows step 1 with the name and phone it already has, and the team card", () => {
    const markup = renderToStaticMarkup(
      <QuickAboutYouStep
        {...base}
        initialName="Clara Schumann"
        initialPhone="+49 30 0000 0000"
        onSubmit={vi.fn()}
      />,
    );
    expect(markup).toContain("Step 1 of 5");
    expect(markup).toContain("Hi! Who&#x27;s setting up the hotel?");
    expect(markup).toContain('value="Clara"');
    expect(markup).toContain('value="Schumann"');
    expect(markup).toContain('value="+49 30 0000 0000"');
    expect(markup).toContain("How your team sees you");
    expect(markup).toContain("Owner · Alpenrose Hotel Group");
    expect(markup).toContain("clara@example.com");
    expect(markup).toContain(">CS<");
    expect(markup).not.toContain("You&#x27;re invited");
    // Step 1 has no Back and no "Saved as you type".
    expect(markup).not.toContain(">Back<");
    expect(markup).not.toContain("Saved as you type");
  });

  it("says the group was invited when it was", () => {
    const markup = renderToStaticMarkup(
      <QuickAboutYouStep {...base} invited initialName="Clara Schumann" onSubmit={vi.fn()} />,
    );
    expect(markup).toContain("You&#x27;re invited");
    expect(markup).toContain(
      "Alpenrose Hotel Group was invited by Vayada. Your plan and products are already set up.",
    );
  });

  it("asks for the missing phone and saves nothing until it is there", async () => {
    const onSubmit = vi.fn(async () => undefined);
    const renderer = create(
      <QuickAboutYouStep {...base} initialName="Clara Schumann" onSubmit={onSubmit} />,
    );
    await submit(renderer);
    expect(onSubmit).not.toHaveBeenCalled();
    const phone = inputs(renderer)[2]!;
    expect(phone.props["aria-invalid"]).toBe(true);
    expect(JSON.stringify(renderer.toJSON())).toContain("Enter your phone number.");

    await type(renderer, 2, "  +49 30 1234 5678 ");
    expect(inputs(renderer)[2]!.props["aria-invalid"]).toBeUndefined();
    await type(renderer, 0, "  Clara  ");
    await submit(renderer);
    expect(onSubmit).toHaveBeenCalledWith({
      firstName: "Clara",
      lastName: "Schumann",
      phone: "+49 30 1234 5678",
    });
    renderer.unmount();
  });

  it("shows why a save failed and lets the owner try again", async () => {
    const onSubmit = vi.fn(async () => {
      throw new Error("We couldn't reach the server. Try again.");
    });
    const renderer = create(
      <QuickAboutYouStep
        {...base}
        initialName="Clara Schumann"
        initialPhone="+49 30 1234 5678"
        onSubmit={onSubmit}
      />,
    );
    await submit(renderer);
    expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toBe(
      "We couldn't reach the server. Try again.",
    );
    expect(
      renderer.root
        .findAllByType("button")
        .filter((button) => button.props.type === "submit")
        .every((button) => !button.props.disabled),
    ).toBe(true);
    renderer.unmount();
  });

  it("uses the same rules as the account details step", () => {
    expect(aboutYouErrors({ firstName: "", lastName: " ", phone: "" })).toEqual({
      firstName: "Enter your first name.",
      lastName: "Enter your last name.",
      phone: "Enter your phone number.",
    });
    expect(aboutYouErrors({ firstName: "Clara", lastName: "S", phone: "12" })).toEqual({
      phone: "Enter a valid phone number.",
    });
    expect(
      aboutYouErrors({ firstName: "Clara", lastName: "x".repeat(120), phone: "+49 30 1234 5678" }),
    ).toEqual({ lastName: "Enter a shorter name." });
  });
});
