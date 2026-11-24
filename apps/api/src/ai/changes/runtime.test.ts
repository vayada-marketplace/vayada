// How the API wires AI changes (VAY-2524): nothing without AI_CHANGES_ENABLED, no MCP change answered
// before MCP connections can be checked, and the executor only once the app exists.
import { randomUUID } from "node:crypto";

import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { buildApp } from "../../app.js";
import {
  WORLD,
  worldAuthorization,
  worldContext,
  worldIdentity,
} from "../actions/actionTestWorld.fixtures.js";
import type { AiOperation } from "../executor/operationStore.js";
import { createAiChangesRuntime, interimChannelActive } from "./runtime.js";

describe("AI changes in the API (VAY-2524)", () => {
  it("counts an in-app conversation as still there and an MCP connection never, for now", async () => {
    const inApp = { surface: "in_app", conversationId: WORLD.CONVERSATION } as AiOperation;
    const mcp = { surface: "mcp", connectionId: WORLD.CONVERSATION } as AiOperation;
    expect(await interimChannelActive(inApp)).toBe(true);
    expect(await interimChannelActive(mcp)).toBe(false);
  });

  it("mounts no Yes/No routes without the setting", async () => {
    const app = buildApp({ logger: false });
    try {
      await app.ready();
      expect(app.hasRoute({ method: "GET", url: "/health" })).toBe(true);
      expect(app.hasRoute({ method: "GET", url: "/api/ai/pending-actions/:id" })).toBe(false);
      expect(app.hasRoute({ method: "POST", url: "/api/ai/pending-actions/:id/answer" })).toBe(
        false,
      );
    } finally {
      await app.close();
    }
  });

  it("runs no change before the app exists, then hands every Yes to the one executor", async () => {
    const runtime = createAiChangesRuntime({
      // Nothing listens here: a store call fails at once, which shows it was made.
      connectionString: "postgresql://127.0.0.1:1/unused_test",
      identity: worldIdentity,
      authorizationResolver: worldAuthorization([]).resolver,
      aiEnabled: async () => true,
      allowedOrigins: ["https://pms.example.test"],
      backgroundWorkersEnabled: false,
    });
    expect(runtime.routes.channelActive).toBe(interimChannelActive);
    expect(runtime.routes.allowedOrigins).toEqual(["https://pms.example.test"]);
    expect(() => runtime.routes.startAndRun(randomUUID())).toThrow("AI changes are not started");

    const app = Fastify({ logger: false });
    runtime.start(app);
    await expect(runtime.routes.startAndRun(randomUUID())).rejects.toThrow(
      "AI operation store query failed",
    );
    // Closing the app stops the recovery job and ends both pools.
    await expect(app.close()).resolves.toBeUndefined();
  });

  it("hands the assistant how to ask for a change, on its own action log; none is offered yet", async () => {
    const runtime = createAiChangesRuntime({
      // Nothing listens here: the ask's log row fails at once, which shows it was written here.
      connectionString: "postgresql://127.0.0.1:1/unused_test",
      identity: worldIdentity,
      authorizationResolver: worldAuthorization([]).resolver,
      aiEnabled: async () => true,
      allowedOrigins: [],
      backgroundWorkersEnabled: false,
    });
    const lines: string[] = [];
    const app = Fastify({
      logger: { level: "error", stream: { write: (line: string) => void lines.push(line) } },
    });
    runtime.start(app);
    const context = await worldContext(WORLD.OWNER, WORLD.ORG_A, ["pms.calendar.manage"]);
    await expect(
      runtime.proposeChange(context, {
        action: "room_block_create@1",
        arguments: {},
        client: "in_app_assistant",
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "unknown_action", message: "This change is not available here." },
    });
    // The row it could not write reaches the app's log; the answer still stands.
    expect(lines.map((line) => JSON.parse(line).msg)).toEqual(["AI action log row not written"]);
    await app.close();
  });

  it("needs a database to keep its changes in", () => {
    expect(() =>
      createAiChangesRuntime({
        connectionString: " ",
        identity: worldIdentity,
        authorizationResolver: worldAuthorization([]).resolver,
        aiEnabled: async () => true,
        allowedOrigins: [],
        backgroundWorkersEnabled: false,
      }),
    ).toThrow("AI changes connectionString must not be empty");
  });
});
