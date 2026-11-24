import type { PermissionKey } from "@vayada/backend-auth";
import { describe, expect, it, vi } from "vitest";

import { CHANGE_ACTIONS } from "../actions/registry.js";
import { roomBlockCreate } from "../actions/roomBlocks.js";
import { WORLD, worldContext } from "../actions/actionTestWorld.fixtures.js";
import { changeTools, inAppChangeActions, type AssistantChangeProposer } from "./changeTools.js";

/**
 * VAY-2518 with VAY-2524: the in-app assistant asks for a change through VAY-2524's proposer and
 * never makes it; the tool's answer is the proposer's result, unchanged, and a new change ends the
 * turn to wait for the person's Yes.
 */
const MODEL = "bedrock:eu-west-1:eu.anthropic.claude-sonnet-5-5";
// No change action has a surface yet (the registry refuses one before Ask first): one as it will be.
const blockInApp = { ...roomBlockCreate, surfaces: ["in_app" as const] };
const BLOCK_RIGHTS: PermissionKey[] = [
  roomBlockCreate.permission,
  ...(roomBlockCreate.alsoNeeds ?? []),
];
const PENDING = {
  ok: true as const,
  pendingActionId: "8f3c2a10-1b2c-4d5e-8f90-123456789abc",
  status: "pending",
  expiresAt: "2026-12-09T09:58:00.000Z",
  created: true,
};
const call = (toolCallId = "toolu_01ABC") => ({
  toolCallId,
  signal: new AbortController().signal,
  turnId: "22222222-2222-4222-8222-222222222222",
});

describe("in-app change tools (VAY-2518, VAY-2524)", () => {
  it("offers only in-app change actions the person holds every right for", async () => {
    const holder = await worldContext(WORLD.OWNER, WORLD.ORG_A, BLOCK_RIGHTS);
    expect(inAppChangeActions(holder, [blockInApp]).map((action) => action.key)).toEqual([
      blockInApp.key,
    ]);
    // Today's registry: no change action is on a surface, so nothing is offered.
    expect(inAppChangeActions(holder, CHANGE_ACTIONS)).toEqual([]);
    // Missing a right, or on MCP: not offered.
    const without = await worldContext(WORLD.OWNER, WORLD.ORG_A, ["pms.room_status.read"]);
    expect(inAppChangeActions(without, [blockInApp])).toEqual([]);
    const mcp = await worldContext(WORLD.OWNER, WORLD.ORG_A, BLOCK_RIGHTS, "mcp");
    expect(inAppChangeActions(mcp, [blockInApp])).toEqual([]);
  });

  it("asks the proposer as the tool call, and hands back its result unchanged", async () => {
    const context = await worldContext(WORLD.OWNER, WORLD.ORG_A, BLOCK_RIGHTS);
    const callContext = await worldContext(WORLD.OWNER, WORLD.ORG_A, BLOCK_RIGHTS);
    const contextFor = vi.fn(async () => callContext);
    const propose = vi.fn<AssistantChangeProposer>(async () => PENDING);
    const [tool] = changeTools({
      context,
      contextFor,
      propose,
      model: MODEL,
      actions: [blockInApp],
    });

    expect(tool!.asksFirst).toBe(true);
    expect(tool!.definition.name).toBe(roomBlockCreate.name);
    expect(tool!.definition.description).toBe(roomBlockCreate.description);
    expect(tool!.definition.inputSchema).toMatchObject({ type: "object" });

    const input = { propertyId: WORLD.P1, reason: "Shower repair" };
    const outcome = await tool!.run(input, call());
    expect(contextFor).toHaveBeenCalledWith("toolu_01ABC");
    expect(propose).toHaveBeenCalledWith(callContext, {
      action: roomBlockCreate.key,
      arguments: input,
      client: "in_app_assistant",
      requestScope: "22222222-2222-4222-8222-222222222222",
      externalCallId: "toolu_01ABC",
      model: MODEL,
    });
    // Unchanged (the panel reads pendingActionId), and the turn waits for the Yes.
    expect(outcome).toEqual({ ok: true, data: PENDING, waitsForAnswer: true });
  });

  it("doesn't wait for an answer already given: a change asked again that is being made", async () => {
    const context = await worldContext(WORLD.OWNER, WORLD.ORG_A, BLOCK_RIGHTS);
    const done = { ...PENDING, status: "running", created: false };
    const [tool] = changeTools({
      context,
      contextFor: async () => context,
      propose: async () => done,
      model: MODEL,
      actions: [blockInApp],
    });
    expect(await tool!.run({}, call())).toEqual({ ok: true, data: done, waitsForAnswer: false });
  });

  it("passes a refusal on as the tool's error", async () => {
    const context = await worldContext(WORLD.OWNER, WORLD.ORG_A, BLOCK_RIGHTS);
    const error = { code: "not_allowed", message: "You may not make this change." };
    const [tool] = changeTools({
      context,
      contextFor: async () => context,
      propose: async () => ({ ok: false, error }),
      model: MODEL,
      actions: [blockInApp],
    });
    expect(await tool!.run({}, call())).toEqual({ ok: false, error });
  });
});
