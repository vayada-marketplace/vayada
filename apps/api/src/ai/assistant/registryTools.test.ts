import type { PermissionKey } from "@vayada/backend-auth";
import { afterAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../app.js";
import { memoryAiActionLog } from "../actionLog/memoryActionLog.fixtures.js";
import { ACTION_FIXTURES } from "../actions/actionFixtures.fixtures.js";
import { WORLD, worldAuthorization, worldContext } from "../actions/actionTestWorld.fixtures.js";
import { registryTools } from "./registryTools.js";

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
