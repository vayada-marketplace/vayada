// How the API wires AI changes (VAY-2524): nothing without AI_CHANGES_ENABLED, an in-app change
// answered only while its chat is there, no MCP change answered before MCP connections can be
// checked, and the executor only once the app exists.
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
import { createAiChangesRuntime } from "./runtime.js";

type RuntimeConfig = Parameters<typeof createAiChangesRuntime>[0];

const runtimeConfig = (overrides: Partial<RuntimeConfig> = {}): RuntimeConfig => ({
  // Nothing listens here: a store call fails at once, which shows it was made.
  connectionString: "postgresql://127.0.0.1:1/unused_test",
  identity: worldIdentity,
  authorizationResolver: worldAuthorization([]).resolver,
  aiEnabled: async () => true,
  chatExists: async () => true,
  allowedOrigins: [],
  backgroundWorkersEnabled: false,
  ...overrides,
});

describe("AI changes in the API (VAY-2524)", () => {
  it("answers an in-app change only while its chat is there and the person's; MCP never yet", async () => {
    const asked: unknown[] = [];
    const gone = randomUUID();
    const runtime = createAiChangesRuntime(
      runtimeConfig({
        chatExists: async (owner, conversationId) => {
          asked.push([owner, conversationId]);
          if (conversationId === WORLD.CONVERSATION) return true;
          if (conversationId === gone) return false;
          throw new Error("chat store query failed (57P01)");
        },
      }),
    );
    const owner = { organizationId: WORLD.ORG_A, propertyId: WORLD.P1, userId: WORLD.OWNER };
    const inApp = (conversationId: string) =>
      ({ ...owner, surface: "in_app", connectionId: null, conversationId }) as AiOperation;
    expect(await runtime.routes.channelActive(inApp(WORLD.CONVERSATION))).toBe(true);
    expect(await runtime.routes.channelActive(inApp(gone))).toBe(false);
    // A check that can't answer isn't a "gone": the route answers "try again" and closes nothing.
    await expect(runtime.routes.channelActive(inApp(randomUUID()))).rejects.toThrow(
      "chat store query failed",
    );
    // The chat is checked against the change's own account, property and person.
    expect(asked.slice(0, 2)).toEqual([
      [owner, WORLD.CONVERSATION],
      [owner, gone],
    ]);
    const mcp = {
      ...owner,
      surface: "mcp",
      connectionId: WORLD.CONVERSATION,
      conversationId: null,
    } as AiOperation;
    expect(await runtime.routes.channelActive(mcp)).toBe(false);
    expect(asked).toHaveLength(3);
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
    const runtime = createAiChangesRuntime(
      runtimeConfig({ allowedOrigins: ["https://pms.example.test"] }),
    );
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
    // The ask's log row fails at once: nothing listens at the database address.
    const runtime = createAiChangesRuntime(runtimeConfig());
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
    expect(() => createAiChangesRuntime(runtimeConfig({ connectionString: " " }))).toThrow(
      "AI changes connectionString must not be empty",
    );
  });
});
