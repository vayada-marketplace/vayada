import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { AuthStateError, type InvitationPreview } from "@/services/auth";
import InviteJoinForm, {
  formatHotelNames,
  inviteFailure,
  inviteSubmitProblem,
  type InviteJoinView,
} from "./InviteJoinForm";

const invitation: InvitationPreview = {
  state: "invitation_ready",
  email: "maria.huber@example.com",
  accountExists: false,
  hotelNames: ["Hotel Alpenrose"],
  inviterName: "Anna Keller",
  inviteeName: "Maria Huber",
  roleKey: "front_desk",
  roleName: "Reservation manager",
};

describe("invite join helpers", () => {
  it("names the hotels in the reader's language", () => {
    expect(formatHotelNames(["Hotel Alpenrose"], "en")).toBe("Hotel Alpenrose");
    expect(formatHotelNames(["Hotel Alpenrose", " Haus am See "], "en")).toBe(
      "Hotel Alpenrose and Haus am See",
    );
    expect(formatHotelNames(["Hotel Alpenrose", "Haus am See"], "de")).toBe(
      "Hotel Alpenrose und Haus am See",
    );
    expect(formatHotelNames(["  "], "en")).toBe("");
  });

  it("checks a new account's name and passwords before sending anything", () => {
    const base = {
      isNew: true,
      name: "Maria",
      password: "long enough",
      confirmPassword: "long enough",
    };
    expect(inviteSubmitProblem(base)).toBeNull();
    expect(inviteSubmitProblem({ ...base, name: "  " })).toBe("auth.invite.nameRequired");
    expect(inviteSubmitProblem({ ...base, password: "short", confirmPassword: "short" })).toBe(
      "auth.invite.passwordTooShort",
    );
    expect(inviteSubmitProblem({ ...base, confirmPassword: "long enougj" })).toBe(
      "auth.invite.passwordsDontMatch",
    );
    expect(
      inviteSubmitProblem({ isNew: false, name: "", password: "x", confirmPassword: "" }),
    ).toBeNull();
    expect(inviteSubmitProblem({ isNew: false, name: "", password: "", confirmPassword: "" })).toBe(
      "auth.invite.passwordRequired",
    );
  });

  it("turns API failures into a dead link or a form message", () => {
    const failure = (status: number, body: Record<string, string>) =>
      inviteFailure(new AuthStateError(status, { message: "x", ...body } as never));

    expect(failure(410, { state: "invitation_unavailable", reason: "expired" })).toEqual({
      unavailableReason: "expired",
      messageKey: "",
    });
    expect(failure(401, { state: "invalid_credentials" }).messageKey).toBe(
      "auth.invite.wrongPassword",
    );
    expect(failure(400, { state: "auth_failed", code: "password_too_weak" }).messageKey).toBe(
      "auth.invite.passwordTooWeak",
    );
    expect(failure(403, { state: "auth_failed", code: "invitation_not_joined" }).messageKey).toBe(
      "auth.invite.notJoined",
    );
    expect(inviteFailure(new Error("network")).messageKey).toBe("auth.login.unexpectedError");
  });
});

describe("InviteJoinForm", () => {
  function render(view: InviteJoinView, error = "") {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        createElement(InviteJoinForm, {
          view,
          name: "Maria Huber",
          password: "",
          confirmPassword: "",
          isSubmitting: false,
          error,
          onNameChange: vi.fn(),
          onPasswordChange: vi.fn(),
          onConfirmPasswordChange: vi.fn(),
          onSubmit: vi.fn(),
        }),
      );
    });
    const text = JSON.stringify(renderer.toJSON());
    const inputIds = renderer.root.findAllByType("input").map((input) => input.props.id);
    return { renderer, text, inputIds };
  }

  it("asks a new address to create an account, with the hotel name and a locked email", () => {
    const { renderer, text, inputIds } = render({ kind: "ready", invitation });

    expect(text).toContain("Join Hotel Alpenrose");
    expect(text).toContain(
      "Anna Keller invited you to join Hotel Alpenrose as Reservation manager.",
    );
    expect(text).toContain("Create account and join");
    expect(text).not.toContain("You already have a vayada account");
    expect(inputIds).toEqual([
      "invite-email",
      "invite-name",
      "invite-password",
      "invite-confirm-password",
    ]);
    const email = renderer.root.findByProps({ id: "invite-email" });
    expect(email.props).toMatchObject({ value: "maria.huber@example.com", readOnly: true });
  });

  it("asks an existing account to log in, with a way to reset the password", () => {
    const { text, inputIds } = render({
      kind: "ready",
      invitation: { ...invitation, accountExists: true, roleName: null },
    });

    expect(text).toContain("You already have a vayada account. Log in to accept this invitation.");
    expect(text).toContain("as Front Desk.");
    expect(text).toContain("Log in and join");
    expect(text).toContain("/forgot-password");
    expect(inputIds).toEqual(["invite-email", "invite-password"]);
  });

  it("shows a wrong password in the login page's error box", () => {
    const { text } = render(
      { kind: "ready", invitation: { ...invitation, accountExists: true } },
      "That password is not right. Try again or reset it.",
    );
    expect(text).toContain("That password is not right. Try again or reset it.");
  });

  it("explains a dead link and an already accepted one without a form", () => {
    const expired = render({ kind: "unavailable", reason: "expired" });
    expect(expired.text).toContain("This invitation link no longer works");
    expect(expired.inputIds).toEqual([]);

    const accepted = render({ kind: "unavailable", reason: "accepted" });
    expect(accepted.text).toContain("This invitation was already accepted");
    expect(accepted.text).toContain("/login");
  });
});
