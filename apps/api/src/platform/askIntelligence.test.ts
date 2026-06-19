import { describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";
import { createOpenAIAskModel } from "./askIntelligence.js";

describe("Ask Intelligence provider wiring", () => {
  it("boots the OpenAI provider config without exposing the API key in metadata", async () => {
    const apiKey = "sk_vayada_smoke_not_real";
    const config = loadConfig({
      ASK_INTELLIGENCE_PROVIDER: "openai",
      ASK_INTELLIGENCE_MODEL: "gpt-5.5",
      OPENAI_API_KEY: apiKey,
    });

    if (config.askIntelligence.provider !== "openai") {
      throw new Error("Expected OpenAI Ask Intelligence config");
    }

    const provider = await createOpenAIAskModel(config.askIntelligence);

    expect(provider.metadata).toEqual({ provider: "openai", model: "gpt-5.5" });
    expect(JSON.stringify(provider.metadata)).not.toContain(apiKey);
    expect(typeof provider.model.getResponse).toBe("function");
  });
});
