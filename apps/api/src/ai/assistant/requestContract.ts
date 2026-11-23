import { createHash } from "node:crypto";

import type { ToolDefinition } from "../actions/registry.js";
import type { ModelRoute } from "../provider/catalog.js";

/**
 * VAY-2518, plan 3.9 "Replay contract": Claude's thinking replay binds the whole prefix of a
 * conversation (system prompt, tool definitions and their order, every earlier message), and a
 * cache only hits on an identical prefix. So each conversation stores what its requests are made
 * of; when a deploy or a permission change would make the next request differ, the conversation
 * is read-only and the next question starts a new one.
 */

/** Bump when the way stored messages are turned into a request changes. */
export const MESSAGE_SERIALIZATION_VERSION = 1;

export type RequestContract = {
  provider: string;
  region: string;
  model: string;
  systemPromptSha256: string;
  /** Call settings that shape the request, e.g. effort and output limit. */
  settings: Record<string, unknown>;
  serializationVersion: number;
  /** In the order they are sent; each as the model sees it (name, description, input schema). */
  tools: { name: string; sha256: string }[];
};

export type SealedRequestContract = { contract: RequestContract; sha256: string };

export function requestContract(input: {
  route: ModelRoute;
  systemPrompt: string;
  settings: Record<string, unknown>;
  tools: readonly ToolDefinition[];
}): SealedRequestContract {
  const contract: RequestContract = {
    provider: input.route.provider,
    region: input.route.region,
    model: input.route.model,
    systemPromptSha256: sha256(input.systemPrompt),
    settings: input.settings,
    serializationVersion: MESSAGE_SERIALIZATION_VERSION,
    // Key order kept: it is part of the bytes sent, so of the cached prefix.
    tools: input.tools.map(({ name, description, inputSchema }) => ({
      name,
      sha256: sha256(JSON.stringify({ name, description, inputSchema })),
    })),
  };
  return { contract, sha256: sha256(canonicalJson(contract)) };
}

/** JSON with object keys sorted at every level; array order is kept, because it matters. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) =>
    nested !== null && typeof nested === "object" && !Array.isArray(nested)
      ? Object.fromEntries(
          Object.entries(nested as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : nested,
  );
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
