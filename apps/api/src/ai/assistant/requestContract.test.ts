import { describe, expect, it } from "vitest";

import type { ToolDefinition } from "../actions/registry.js";
import type { ModelRoute } from "../provider/catalog.js";
import {
  canonicalJson,
  MESSAGE_SERIALIZATION_VERSION,
  requestContract,
} from "./requestContract.js";

const SONNET: ModelRoute = {
  provider: "bedrock",
  region: "eu-west-1",
  model: "eu.anthropic.claude-sonnet-5-5",
};
const tool = (name: string, description = `Reads ${name}`): ToolDefinition => ({
  name,
  description,
  inputSchema: { type: "object", properties: { propertyId: { type: "string" } } },
  outputSchema: { type: "object" },
});
const contractOf = (overrides: Partial<Parameters<typeof requestContract>[0]> = {}) =>
  requestContract({
    route: SONNET,
    systemPrompt: "You are vayada's assistant.",
    settings: { effort: "low", maxOutputTokens: 8_000 },
    tools: [tool("rooms_list"), tool("calendar_days")],
    ...overrides,
  });

describe("request contract (VAY-2518)", () => {
  it("names the provider, model, prompt, settings and every tool in its order", () => {
    const { contract, sha256 } = contractOf();
    expect(contract).toMatchObject({
      provider: "bedrock",
      region: "eu-west-1",
      model: "eu.anthropic.claude-sonnet-5-5",
      systemPromptSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      settings: { effort: "low", maxOutputTokens: 8_000 },
      serializationVersion: MESSAGE_SERIALIZATION_VERSION,
    });
    expect(contract.tools.map((entry) => entry.name)).toEqual(["rooms_list", "calendar_days"]);
    expect(contract.tools[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(contract)).not.toContain("vayada's assistant");
  });

  it("is the same for the same requests, and ignores what the model never sees", () => {
    expect(contractOf().sha256).toBe(contractOf().sha256);
    const otherOutput = { ...tool("rooms_list"), outputSchema: { type: "array" } };
    expect(contractOf({ tools: [otherOutput, tool("calendar_days")] }).sha256).toBe(
      contractOf().sha256,
    );
    expect(contractOf({ settings: { maxOutputTokens: 8_000, effort: "low" } }).sha256).toBe(
      contractOf().sha256,
    );
  });

  it.each([
    ["another model", { route: { ...SONNET, model: "eu.anthropic.claude-haiku-5-5" } }],
    ["another region", { route: { ...SONNET, region: "eu-central-1" } }],
    ["a changed system prompt", { systemPrompt: "You are vayada's assistant. Be brief." }],
    ["other settings", { settings: { effort: "medium", maxOutputTokens: 8_000 } }],
    ["the tools in another order", { tools: [tool("calendar_days"), tool("rooms_list")] }],
    ["a tool fewer (a permission change)", { tools: [tool("rooms_list")] }],
    [
      "a changed tool description",
      { tools: [tool("rooms_list", "Lists rooms"), tool("calendar_days")] },
    ],
    [
      "a tool's schema sent in another key order",
      {
        tools: [
          {
            ...tool("rooms_list"),
            inputSchema: { properties: { propertyId: { type: "string" } }, type: "object" },
          },
          tool("calendar_days"),
        ],
      },
    ],
  ])("changes with %s", (_change, overrides) => {
    expect(contractOf(overrides).sha256).not.toBe(contractOf().sha256);
  });

  it("sorts object keys at every level and keeps array order", () => {
    expect(canonicalJson({ b: [{ d: 1, c: 2 }, 3], a: null })).toBe(
      '{"a":null,"b":[{"c":2,"d":1},3]}',
    );
  });
});
