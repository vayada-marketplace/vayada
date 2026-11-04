import { describe, expect, it } from "vitest";

import {
  parseWorkosUserResyncArgs,
  summarizeWorkosUserResyncPlan,
  type WorkosUserResyncPlan,
} from "./workosUserResync.js";

const sha = "a".repeat(64);

describe("WorkOS user resync arguments (VAY-2479)", () => {
  it("is a dry run unless --apply names a plan SHA-256", () => {
    expect(parseWorkosUserResyncArgs(["--approval-ref", "VAY-2479"])).toEqual({
      approvalRef: "VAY-2479",
      applyPlanSha256: null,
    });
    expect(parseWorkosUserResyncArgs(["--approval-ref", "VAY-2479", "--apply", sha])).toEqual({
      approvalRef: "VAY-2479",
      applyPlanSha256: sha,
    });
  });

  const refusals: [string[], string][] = [
    [[], "approval_ref_invalid"],
    [["--approval-ref", "x"], "approval_ref_invalid"],
    [["--approval-ref", "VAY-2479\nother"], "approval_ref_invalid"],
    [["--approval-ref", "VAY-2479", "--apply"], "arguments_invalid"],
    [["--approval-ref", "VAY-2479", "--apply", "abc"], "plan_sha256_invalid"],
    [["--approval-ref", "VAY-2479", "--apply", sha.toUpperCase()], "plan_sha256_invalid"],
    [["--approval-ref", "VAY-2479", "--apply", sha, "--apply", sha], "arguments_invalid"],
    [["--approval-ref", "VAY-2479", "--force", "yes"], "arguments_invalid"],
  ];
  it.each(refusals)("refuses %j", (argv, code) => {
    let refusal: unknown;
    try {
      parseWorkosUserResyncArgs(argv);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({ name: "WorkosUserResyncRefusal", code });
  });
});

describe("WorkOS user resync summary", () => {
  it("prints short references, outcomes, field names and counts, never values", () => {
    const plan: WorkosUserResyncPlan = {
      planSha256: sha,
      users: [
        {
          workosUserId: "user_01KAAAAAAAAAAAAAAAAAUPDATE1",
          userId: "11111111-1111-4111-8111-111111111111",
          outcome: "update",
          changes: ["email_verified"],
          deadLetters: [
            { deadLetterId: "d1", receiptId: "r1" },
            { deadLetterId: "d2", receiptId: "r2" },
          ],
          before: "b",
          after: "c",
          payload: {
            workosUserId: "user_01KAAAAAAAAAAAAAAAAAUPDATE1",
            email: "person@example.com",
            name: "Real Person",
            emailVerified: true,
            status: "active",
            rawProfile: {},
          },
        },
        {
          workosUserId: "user_01KAAAAAAAAAAAAAAAAMISSING1",
          userId: "22222222-2222-4222-8222-222222222222",
          outcome: "missing_in_workos",
          changes: [],
          deadLetters: [{ deadLetterId: "d3", receiptId: "r3" }],
          before: "b",
          after: null,
          payload: null,
        },
      ],
      smoke: { deadLetterIds: ["d4", "d5"], users: 1, usersNotDeleted: 0 },
    };

    const summary = summarizeWorkosUserResyncPlan(plan);

    expect(summary).toEqual({
      users: [
        { ref: "…AUPDATE1", outcome: "update", changes: ["email_verified"], deadLetters: 2 },
        { ref: "…MISSING1", outcome: "missing_in_workos", changes: [], deadLetters: 1 },
      ],
      totals: {
        users: 2,
        update: 1,
        inSync: 0,
        userDeleted: 0,
        skipped: 1,
        deadLettersToResolve: 2,
        deadLettersLeftOpen: 1,
      },
      smoke: { deadLettersToAcknowledge: 2, users: 1, usersNotDeleted: 0 },
    });
    const printed = JSON.stringify(summary);
    expect(printed).not.toContain("person@example.com");
    expect(printed).not.toContain("Real Person");
    expect(printed).not.toContain("user_01K");
  });
});
