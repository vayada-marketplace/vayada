import { describe, expect, it } from "vitest";

import { createOpenAIAskModel } from "./askIntelligence.js";

describe("Ask Intelligence provider wiring", () => {
  it("creates an OpenAI Agents SDK model wrapper with audit metadata", async () => {
    const provider = await createOpenAIAskModel({
      provider: "openai",
      apiKey: "sk_test",
      model: "gpt-5.4-mini",
    });

    expect(provider.metadata).toEqual({ provider: "openai", model: "gpt-5.4-mini" });
    expect(typeof provider.model.getResponse).toBe("function");
  });
});
