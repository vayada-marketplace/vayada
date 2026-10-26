import type { ReactElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import SharedHotelLoginForm from "./SharedHotelLoginForm";
import SharedSignupPage from "./SharedSignupPage";

// A click before the page hydrates submits the plain HTML form. Without method="post" the browser sends a GET, and
// the email and password land in the URL, the browser history and any request log (VAY-2271).
describe("shared hotel auth forms", () => {
  const formMethod = async (element: ReactElement) => {
    let view: ReactTestRenderer;
    await act(async () => {
      view = create(element);
    });
    const method = view!.root.findByType("form").props.method;
    act(() => view!.unmount());
    return method;
  };

  it("posts the sign-in form", async () => {
    expect(
      await formMethod(
        <SharedHotelLoginForm
          copy={{
            title: "Sign in",
            subtitle: "",
            chooseOrganizationTitle: "",
            chooseOrganizationSubtitle: "",
            emailLabel: "Email address",
            passwordLabel: "Password",
            submitLabel: "Sign In",
            submittingLabel: "Signing in",
            noAccount: "",
            signUp: "",
          }}
          email=""
          password=""
          isSubmitting={false}
          submitError=""
          onEmailChange={vi.fn()}
          onPasswordChange={vi.fn()}
          onSubmit={vi.fn()}
          onOrganizationSelect={vi.fn()}
        />,
      ),
    ).toBe("post");
  });

  it("posts the sign-up form", async () => {
    expect(
      await formMethod(
        <SharedSignupPage
          isSubmitting={false}
          submitError=""
          onErrorClear={vi.fn()}
          onSubmit={vi.fn()}
        />,
      ),
    ).toBe("post");
  });
});
