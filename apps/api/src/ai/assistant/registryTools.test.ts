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
    });
    expect(outcome).toMatchObject({ ok: false, error: { code: "stopped" } });
    await slowApp.close();
  });
});
