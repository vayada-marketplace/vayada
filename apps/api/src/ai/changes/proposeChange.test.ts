// How an AI asks for a change (VAY-2524): only changes offered on its surface, with valid input,
// on a property and with rights the person has now; the ask is one pending operation and one log
// row, and nothing runs.
import { describe, expect, it } from "vitest";

import { memoryAiActionLog } from "../actionLog/memoryActionLog.fixtures.js";
import { WORLD, FORBIDDEN, worldContext } from "../actions/actionTestWorld.fixtures.js";
import type { ChangeAction } from "../actions/defineChangeAction.js";
import { CHANGE_ACTIONS } from "../actions/registry.js";
import { roomBlockCreate } from "../actions/roomBlocks.js";
import type { AiOperation, AiOperationStore, ProposedChange } from "../executor/operationStore.js";
import { createAiChangeProposer } from "./proposeChange.js";

const { OWNER, MEMBER, ORG_A, P1, P2, CONVERSATION } = WORLD;
const DELUXE = "eeeeeeee-0000-4000-8000-000000000001";
const R12 = "ffffffff-0000-4000-8000-000000000012";
const OP = "11111111-0000-4000-8000-000000000001";
const NOW = new Date("2026-12-09T09:40:00Z");
const CALENDAR = ["pms.calendar.manage", "pms.calendar.read"] as const;

const inApp = { ...roomBlockCreate, surfaces: ["in_app"] } as ChangeAction;
const args = (propertyId: string = P1) => ({
  propertyId,
  roomTypeId: DELUXE,
  roomIds: [R12],
  startsOn: "2026-12-12",
  endsOn: "2026-12-14",
  reason: "  shower repair ",
});

function setUp(offered: readonly ChangeAction[] = [inApp], storeFails = false) {
  const proposed: ProposedChange[] = [];
  const store: Pick<AiOperationStore, "propose"> = {
    async propose(change) {
      if (storeFails) throw new Error("AI operation store query failed (57P01)");
      proposed.push(change);
      return {
        operation: {
          id: OP,
          status: "pending",
          expiresAt: "2026-12-09T09:55:00.000Z",
        } as AiOperation,
        created: true,
      };
    },
  };
  const log = memoryAiActionLog();
  const failures: unknown[] = [];
  const propose = createAiChangeProposer({
    store,
    log,
    onLogFailure: (error) => failures.push(error),
    findAction: (key) => offered.find((action) => action.key === key),
    now: () => NOW,
  });
  return { propose, proposed, log, failures };
}

describe("an AI asking for a change (VAY-2524)", () => {
  it("records one pending change and one log row, and runs nothing", async () => {
    const { propose, proposed, log, failures } = setUp();
    const context = await worldContext(OWNER, ORG_A, CALENDAR);
    const result = await propose(context, {
      action: "room_block_create@1",
      arguments: args(),
      client: "vayada:pms",
      requestScope: "turn-7",
      externalCallId: "toolu_01",
    });
    expect(result).toEqual({
      ok: true,
      pendingActionId: OP,
      status: "pending",
      expiresAt: "2026-12-09T09:55:00.000Z",
      created: true,
    });
    expect(proposed).toEqual([
      {
        organizationId: ORG_A,
        propertyId: P1,
        userId: OWNER,
        surface: "in_app",
        connectionId: undefined,
        conversationId: CONVERSATION,
        requestScope: "turn-7",
        client: "vayada:pms",
        action: inApp,
        // As checked: the reason trimmed.
        arguments: { ...args(), reason: "shower repair" },
      },
    ]);
    expect(log.rows).toEqual([
      expect.objectContaining({
        action: "room_block_create",
        group: "ask",
        outcome: "ok",
        operationId: OP,
        correlationId: `op_${OP}`,
        propertyId: P1,
        userId: OWNER,
        surface: "in_app",
        conversationId: CONVERSATION,
        recordsChanged: [],
        externalCallId: "toolu_01",
        requestId: context.delegation!.toolCallId,
      }),
    ]);
    // The free-text reason is never logged.
    expect(JSON.stringify(log.rows)).not.toContain("shower");
    expect(failures).toEqual([]);
  });

  it("asks on MCP on the connection", async () => {
    const both = { ...roomBlockCreate, surfaces: ["in_app", "mcp"] } as ChangeAction;
    const { propose, proposed } = setUp([both]);
    const result = await propose(await worldContext(OWNER, ORG_A, CALENDAR, "mcp"), {
      action: "room_block_create@1",
      arguments: args(),
      client: "claude.ai",
    });
    expect(result.ok).toBe(true);
    expect(proposed[0]).toMatchObject({
      surface: "mcp",
      connectionId: CONVERSATION,
      conversationId: undefined,
    });
  });

  it("offers no change anywhere yet: AI stays off", async () => {
    const { propose, proposed, log } = setUp(CHANGE_ACTIONS);
    for (const action of CHANGE_ACTIONS) {
      const result = await propose(await worldContext(OWNER, ORG_A, CALENDAR), {
        action: action.key,
        arguments: args(),
        client: "vayada:pms",
      });
      expect(result).toEqual({
        ok: false,
        error: { code: "unknown_action", message: "This change is not available here." },
      });
    }
    expect(proposed).toEqual([]);
    expect(log.rows.map((row) => row.outcome)).toEqual(CHANGE_ACTIONS.map(() => "invalid"));
  });

  it("refuses an in-app change on MCP, and an unknown one", async () => {
    const { propose, proposed } = setUp();
    const mcp = await worldContext(OWNER, ORG_A, CALENDAR, "mcp");
    for (const action of ["room_block_create@1", "room_block_create@2", "anything"]) {
      expect(await propose(mcp, { action, arguments: args(), client: "claude.ai" })).toMatchObject({
        ok: false,
        error: { code: "unknown_action" },
      });
    }
    expect(proposed).toEqual([]);
  });

  it("refuses invalid input, naming paths, never the values sent", async () => {
    const { propose, proposed, log } = setUp();
    const result = await propose(await worldContext(OWNER, ORG_A, CALENDAR), {
      action: "room_block_create@1",
      arguments: { ...args(), roomIds: [FORBIDDEN], extra: FORBIDDEN },
      client: "vayada:pms",
    });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(JSON.stringify(result)).not.toContain(FORBIDDEN);
    expect(JSON.stringify(log.rows)).not.toContain(FORBIDDEN);
    expect(log.rows).toEqual([expect.objectContaining({ outcome: "invalid", propertyId: null })]);
    expect(proposed).toEqual([]);
  });

  it("refuses a property outside the person's access, and a change their rights don't allow", async () => {
    const { propose, proposed, log } = setUp();
    // The member may use P1 only.
    const member = await worldContext(MEMBER, ORG_A, CALENDAR);
    expect(
      await propose(member, { action: "room_block_create@1", arguments: args(P2), client: "x" }),
    ).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    const reader = await worldContext(OWNER, ORG_A, ["pms.calendar.read"]);
    expect(
      await propose(reader, { action: "room_block_create@1", arguments: args(), client: "x" }),
    ).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    expect(log.rows.map((row) => [row.outcome, row.propertyId])).toEqual([
      ["denied", null],
      ["denied", P1],
    ]);
    expect(proposed).toEqual([]);
  });

  it("refuses nights in the wrong order as invalid input, never as a card that changed", async () => {
    const { propose, proposed } = setUp();
    expect(
      await propose(await worldContext(OWNER, ORG_A, CALENDAR), {
        action: "room_block_create@1",
        arguments: { ...args(), endsOn: "2026-12-11" },
        client: "vayada:pms",
      }),
    ).toEqual({
      ok: false,
      error: { code: "invalid_input", message: "endsOn: must not be before startsOn" },
    });
    expect(proposed).toEqual([]);
  });

  it("passes vayada's own preview digest and its shorter expiry to the stored change", async () => {
    const { propose, proposed } = setUp();
    await propose(await worldContext(OWNER, ORG_A, CALENDAR), {
      action: "room_block_create@1",
      arguments: args(),
      client: "vayada:pms",
      previewSha256: "b".repeat(64),
      expiresInMs: 600_000,
    });
    expect(proposed[0]).toMatchObject({ previewSha256: "b".repeat(64), expiresInMs: 600_000 });
  });

  it("logs an ask the store could not keep, then throws", async () => {
    const { propose, log } = setUp([inApp], true);
    await expect(
      propose(await worldContext(OWNER, ORG_A, CALENDAR), {
        action: "room_block_create@1",
        arguments: args(),
        client: "vayada:pms",
      }),
    ).rejects.toThrow("AI operation store query failed");
    expect(log.rows).toEqual([
      expect.objectContaining({ outcome: "failed", errorCode: "store_failed", operationId: null }),
    ]);
  });

  it("needs the tool call's own delegated context", async () => {
    const { propose } = setUp();
    const context = await worldContext(OWNER, ORG_A, CALENDAR);
    await expect(
      propose({ ...context, delegation: undefined }, { action: "x", arguments: {}, client: "x" }),
    ).rejects.toThrow(TypeError);
    await expect(
      propose(
        { ...context, delegation: { ...context.delegation!, conversationId: undefined } },
        { action: "room_block_create@1", arguments: args(), client: "x" },
      ),
    ).rejects.toThrow(TypeError);
  });
});
