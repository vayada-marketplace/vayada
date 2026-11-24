import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../../app.js";
import { memoryAiActionLog } from "../actionLog/memoryActionLog.fixtures.js";
import { worldAuthorization } from "../actions/actionTestWorld.fixtures.js";
import type { AssistantChangeProposer } from "./changeTools.js";
import { memoryConversationStore } from "./memoryConversationStore.fixtures.js";
import { delegatedAssistantTools } from "./registryTools.js";

vi.mock("./registryTools.js", async (original) => {
  const actual = await original<typeof import("./registryTools.js")>();
  return { ...actual, delegatedAssistantTools: vi.fn(actual.delegatedAssistantTools) };
});

/**
 * VAY-2518 with VAY-2524: buildApp hands the assistant VAY-2524's proposer (server.ts passes it
 * only with AI_CHANGES_ENABLED); without one the assistant only reads.
 */
describe("the assistant's proposer in buildApp", () => {
  const appWith = (propose?: AssistantChangeProposer) =>
    buildApp({
      logger: false,
      auth: worldAuthorization([]).auth,
      assistant: {
        store: memoryConversationStore().store,
        provider: { routeFor: () => undefined, step: vi.fn() },
        actionLog: memoryAiActionLog(),
        ...(propose ? { propose } : {}),
      },
    });
  const lastOptions = () => vi.mocked(delegatedAssistantTools).mock.lastCall![1];

  it("passes the proposer on to the assistant's tools", async () => {
    const propose = vi.fn<AssistantChangeProposer>();
    const app = appWith(propose);
    expect(lastOptions().propose).toBe(propose);
    await app.close();
  });

  it("passes none without one", async () => {
    const app = appWith();
    expect(lastOptions()).not.toHaveProperty("propose");
    await app.close();
  });
});
