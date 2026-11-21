import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const API_SRC = fileURLToPath(new URL("../..", import.meta.url));
const PROVIDER_DIR = fileURLToPath(new URL(".", import.meta.url));

const QUOTE = "[\"'`]";
const NOT_QUOTE = "[^\"'`]";
/** `from "x"`, `import "x"`, `import("x")`, `require("x")`. */
const LOADS = String.raw`(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)`;

/**
 * Model SDKs may only be loaded in ai/provider, so every model call passes the EU allow-list,
 * prices and budgets, and swapping the framework touches one folder (plan 3.11).
 */
const MODEL_SDK = new RegExp(
  `${LOADS}${QUOTE}(?:ai|openai|@ai-sdk/${NOT_QUOTE}+|@mastra/${NOT_QUOTE}+|@anthropic-ai/${NOT_QUOTE}+|` +
    `@aws-sdk/client-bedrock${NOT_QUOTE}*|@google/genai|@google-cloud/vertexai|@mistralai/${NOT_QUOTE}+)` +
    `(?:${QUOTE}|/)`,
);
/** Never anywhere: Mastra's HTTP servers expose unauthenticated routes, `ee/` has another licence (research 09 §7). */
const FORBIDDEN = new RegExp(
  `${QUOTE}@mastra/(?:fastify|server|hono|express|koa|deployer|${NOT_QUOTE}*/(?:ee|dist))(?:/${NOT_QUOTE}*)?${QUOTE}`,
);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("AI SDK import boundary", () => {
  const files = sourceFiles(API_SRC);
  const name = (file: string) => relative(API_SRC, file).split(sep).join("/");

  it("recognises the ways a module is loaded", () => {
    for (const line of [
      'import { generateText } from "ai";',
      "import type { LanguageModel } from 'ai';",
      'import "ai";',
      "const sdk = await import(`ai`);",
      'const { Agent } = require("@mastra/core/agent");',
      'export * from "@ai-sdk/amazon-bedrock/anthropic";',
      'import Anthropic from "@anthropic-ai/sdk";',
      'import OpenAI from "openai";',
      'import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";',
    ])
      expect(line).toMatch(MODEL_SDK);
    for (const line of [
      'import { x } from "./ai/provider/aiProvider.js";',
      'import { S3Client } from "@aws-sdk/client-s3";',
      'import openaiish from "openai-compatible";',
      'const label = "ai";',
    ])
      expect(line).not.toMatch(MODEL_SDK);
    for (const line of [
      'import { MastraServer } from "@mastra/fastify";',
      'import { handlers } from "@mastra/server/handlers";',
      'import x from "@mastra/core/ee/rbac";',
      'import x from "@mastra/core/dist/ee-x.js";',
    ])
      expect(line).toMatch(FORBIDDEN);
    expect('import { Agent } from "@mastra/core/agent";').not.toMatch(FORBIDDEN);
  });

  it("scans the API source", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("keeps model SDK imports inside ai/provider", () => {
    const outside = files.filter(
      (file) => !file.startsWith(PROVIDER_DIR) && MODEL_SDK.test(readFileSync(file, "utf8")),
    );
    expect(outside.map(name)).toEqual([]);
  });

  it("never imports Mastra's HTTP servers or its separately licensed code", () => {
    const offending = files.filter(
      (file) =>
        file !== fileURLToPath(import.meta.url) && FORBIDDEN.test(readFileSync(file, "utf8")),
    );
    expect(offending.map(name)).toEqual([]);
  });
});
