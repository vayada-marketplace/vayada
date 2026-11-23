import type { PermissionKey, RequestContext } from "@vayada/backend-auth";
import { afterAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../app.js";
import { memoryAiActionLog } from "../actionLog/memoryActionLog.fixtures.js";
import { ACTION_FIXTURES } from "../actions/actionFixtures.fixtures.js";
import {
  WORLD,
  worldAuthorization,
  worldContext,
  worldIdentity,
} from "../actions/actionTestWorld.fixtures.js";
import { roomBlockCreate } from "../actions/roomBlocks.js";
import type { AssistantChangeProposer } from "./changeTools.js";
import { delegatedAssistantTools, registryTools } from "./registryTools.js";

/**
 * VAY-2518: the assistant's tools are the registry's in-app actions, run through their real
 * routes as the signed-in user, each call logged with the model's tool-call id.
 */
const MODEL = "bedrock:eu-west-1:eu.anthropic.claude-sonnet-5-5";
const rooms = ACTION_FIXTURES.find((fixture) => fixture.action === "rooms_list@1")!;
const ROOMS_ONLY: PermissionKey[] = ["pms.room_status.read"];

const app = buildApp({
  logger: false,
  ...rooms.appOptions(),
  auth: worldAuthorization(ROOMS_ONLY).auth,
});
afterAll(async () => {
  await app.close();
});

describe("assistant tools from the action registry (VAY-2518)", () => {
  it("offers only the actions the user's rights allow, as the registry defines them", async () => {
    const context = await worldContext(WORLD.OWNER, WORLD.ORG_A, ROOMS_ONLY);
    const tools = registryTools(app, {
      context,
      contextFor: () => worldContext(WORLD.OWNER, WORLD.ORG_A, ROOMS_ONLY),
      log: memoryAiActionLog(),
      model: MODEL,
    });
    expect(tools.map((tool) => tool.definition.name)).toEqual(["rooms_list"]);
    expect(tools[0]!.definition.inputSchema).toMatchObject({ type: "object" });
  });

  it("runs a call as the user with a fresh delegated context and logs it with the tool-call id", async () => {
    const context = await worldContext(WORLD.OWNER, WORLD.ORG_A, ROOMS_ONLY);
    const contextFor = vi.fn(() => worldContext(WORLD.OWNER, WORLD.ORG_A, ROOMS_ONLY));
    const log = memoryAiActionLog();
    const [tool] = registryTools(app, { context, contextFor, log, model: MODEL });

    const outcome = await tool!.run(rooms.input(WORLD.P1), {
      toolCallId: "toolu_01ABC",
      signal: new AbortController().signal,
      turnId: "turn-1",
    });
    expect(outcome).toMatchObject({ ok: true });
    expect(contextFor).toHaveBeenCalledWith("toolu_01ABC");
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0]).toMatchObject({
      surface: "in_app",
      client: "in_app_assistant",
      action: "rooms_list",
      externalCallId: "toolu_01ABC",
      model: MODEL,
      outcome: "ok",
    });

    // Another account's property is refused like any request the user makes.
    const refused = await tool!.run(rooms.input(WORLD.P3), {
      toolCallId: "toolu_01ABD",
      signal: new AbortController().signal,
      turnId: "turn-1",
    });
    expect(refused).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    expect(log.rows).toHaveLength(2);
  });
});

describe("who may use the assistant for a property (VAY-2518, the production check)", () => {
  const session = (userId: string, organizationId: string) =>
    ({
      actor: { internalUserId: userId },
      selectedOrganization: { organizationId },
    }) as unknown as RequestContext;
  const toolsFor = (log = memoryAiActionLog()) =>
    delegatedAssistantTools(app, {
      identityRepository: worldIdentity,
      authorizationResolver: worldAuthorization(ROOMS_ONLY).resolver,
      log,
      model: () => MODEL,
    });
  const names = (tools: Awaited<ReturnType<ReturnType<typeof toolsFor>>>) =>
    tools?.map((tool) => tool.definition.name);

  it("gives a member the tools for their own properties, and nothing for any other", async () => {
    const forUser = (userId: string, propertyId: string) =>
      toolsFor()({
        session: session(userId, WORLD.ORG_A),
        propertyId,
        conversationId: WORLD.CONVERSATION,
      });
    expect(names(await forUser(WORLD.OWNER, WORLD.P1))).toEqual(["rooms_list"]);
    expect(names(await forUser(WORLD.MEMBER, WORLD.P1))).toEqual(["rooms_list"]);
    // The member is assigned to P1 only; P3 is another account's.
    expect(await forUser(WORLD.MEMBER, WORLD.P2)).toBeUndefined();
    expect(await forUser(WORLD.OWNER, WORLD.P3)).toBeUndefined();
    // Someone who is not a member at all.
    expect(await forUser("aaaaaaaa-0000-4000-8000-0000000000ff", WORLD.P1)).toBeUndefined();
  });

  it("delegates every tool call for the chat it belongs to", async () => {
    const log = memoryAiActionLog();
    const tools = await toolsFor(log)({
      session: session(WORLD.OWNER, WORLD.ORG_A),
      propertyId: WORLD.P1,
      conversationId: WORLD.CONVERSATION,
    });
    const outcome = await tools![0]!.run(rooms.input(WORLD.P1), {
      toolCallId: "toolu_02",
      signal: new AbortController().signal,
      turnId: "turn-1",
    });
    expect(outcome).toMatchObject({ ok: true });
    expect(log.rows[0]).toMatchObject({
      conversationId: WORLD.CONVERSATION,
      externalCallId: "toolu_02",
      outcome: "ok",
    });
  });

  it("gives up on a slow route when the turn is stopped", async () => {
    const stop = new AbortController();
    const slowApp = buildApp({
      logger: false,
      ...rooms.appOptions(),
      auth: worldAuthorization(ROOMS_ONLY).auth,
    });
    slowApp.addHook("preHandler", async () => {
      stop.abort();
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    const tools = await delegatedAssistantTools(slowApp, {
      identityRepository: worldIdentity,
      authorizationResolver: worldAuthorization(ROOMS_ONLY).resolver,
      log: memoryAiActionLog(),
      model: () => MODEL,
    })({
      session: session(WORLD.OWNER, WORLD.ORG_A),
      propertyId: WORLD.P1,
      conversationId: WORLD.CONVERSATION,
    });
    const outcome = await tools![0]!.run(rooms.input(WORLD.P1), {
      toolCallId: "toolu_03",
      signal: stop.signal,
      turnId: "turn-1",
    });
    expect(outcome).toMatchObject({ ok: false, error: { code: "stopped" } });
    await slowApp.close();
  });
});

describe("change tools in the production check (VAY-2518 with VAY-2524)", () => {
  // No change action has a surface yet: one as it will be.
  const blockInApp = { ...roomBlockCreate, surfaces: ["in_app" as const] };
  const rights: PermissionKey[] = [
    ...ROOMS_ONLY,
    roomBlockCreate.permission,
    ...(roomBlockCreate.alsoNeeds ?? []),
  ];
  const session = (impersonated: boolean) =>
    ({
      actor: {
        internalUserId: WORLD.OWNER,
        providerIdentity: {
          provider: "workos",
          providerUserId: "user_01",
          ...(impersonated ? { impersonated: true } : {}),
        },
      },
      selectedOrganization: { organizationId: WORLD.ORG_A },
    }) as unknown as RequestContext;
  const toolsFor = (propose: AssistantChangeProposer) =>
    delegatedAssistantTools(app, {
      identityRepository: worldIdentity,
      authorizationResolver: worldAuthorization(rights).resolver,
      log: memoryAiActionLog(),
      model: () => MODEL,
      propose,
      changeActions: [blockInApp],
    });

  it("asks the proposer with the tool call's own context, for this chat", async () => {
    const propose = vi.fn<AssistantChangeProposer>(async () => ({
      ok: true,
      pendingActionId: "8f3c2a10-1b2c-4d5e-8f90-123456789abc",
      status: "pending",
      expiresAt: null,
      created: true,
    }));
    const tools = await toolsFor(propose)({
      session: session(false),
      propertyId: WORLD.P1,
      conversationId: WORLD.CONVERSATION,
    });
    const change = tools!.find((tool) => tool.asksFirst)!;
    expect(change.definition.name).toBe(roomBlockCreate.name);
    await change.run(
      { propertyId: WORLD.P1 },
      {
        toolCallId: "toolu_09",
        signal: new AbortController().signal,
        turnId: "22222222-2222-4222-8222-222222222222",
      },
    );
    // proposeChange refuses a context without the in-app conversation: it carries this chat.
    const [context] = propose.mock.calls[0]!;
    expect(context.delegation).toMatchObject({
      channel: "in_app",
      conversationId: WORLD.CONVERSATION,
      toolCallId: "toolu_09",
    });
  });

  it("offers staff signed in as the person no change tools", async () => {
    const tools = await toolsFor(vi.fn())({
      session: session(true),
      propertyId: WORLD.P1,
      conversationId: WORLD.CONVERSATION,
    });
    expect(tools!.some((tool) => tool.asksFirst)).toBe(false);
    expect(tools!.map((tool) => tool.definition.name)).toContain("rooms_list");
  });
});
