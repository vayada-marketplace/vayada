import { OpenAIProvider, type Model } from "@openai/agents";

import type { ApiAskIntelligenceConfig } from "../config.js";

type OpenAIAskIntelligenceConfig = Extract<ApiAskIntelligenceConfig, { provider: "openai" }>;

export type AskModelProvider = {
  model: Model;
  metadata: { provider: "openai"; model: string };
};

export async function createOpenAIAskModel(
  config: OpenAIAskIntelligenceConfig,
): Promise<AskModelProvider> {
  const provider = new OpenAIProvider({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    organization: config.organization,
    project: config.project,
    useResponses: true,
    useResponsesWebSocket: false,
  });
  return {
    model: await provider.getModel(config.model),
    metadata: { provider: "openai", model: config.model },
  };
}
