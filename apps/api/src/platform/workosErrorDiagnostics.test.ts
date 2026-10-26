import { describe, expect, it } from "vitest";
import { workosErrorDiagnostics } from "./workosErrorDiagnostics.js";

describe("workosErrorDiagnostics", () => {
  it.each([
    null,
    undefined,
    "secret",
    new Error("secret"),
    {
      code: "private@example.test",
      status: "401",
      requestID: "Bearer secret",
    },
  ])("omits unsafe or absent metadata", (error) => {
    expect(JSON.stringify(workosErrorDiagnostics(error))).toBe("{}");
  });

  it("keeps only the safe reason codes WorkOS lists", () => {
    expect(
      workosErrorDiagnostics({
        code: "user_creation_error",
        status: 400,
        errors: [
          { code: "email_not_available", message: "private@example.test is not available." },
          { code: "Bearer secret" },
          "secret",
          null,
        ],
      }),
    ).toEqual({ code: "user_creation_error", errorCodes: ["email_not_available"], status: 400 });
    expect(JSON.stringify(workosErrorDiagnostics({ errors: [{ code: "Bearer secret" }] }))).toBe(
      "{}",
    );
  });
});
