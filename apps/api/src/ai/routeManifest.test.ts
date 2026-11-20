// The route list AI actions are generated from (VAY-2507). It is captured from the real app: every
// optional route module switched on with stand-in dependencies, every route recorded through
// Fastify's onRoute hook. CI fails when a route is added, renamed or removed and the checked-in
// list was not regenerated; the classification test then makes someone sort the new route.
//
// Regenerate: UPDATE_AI_ROUTE_MANIFEST=1 npm --workspace vayada-api run test -- src/ai/routeManifest.test.ts
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createFakeVerifier, type IdentityRepository } from "@vayada/backend-auth";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { ROUTE_MANIFEST } from "./routeManifest.generated.js";

const GENERATED = new URL("./routeManifest.generated.ts", import.meta.url);
const SOURCE = fileURLToPath(new URL("../", import.meta.url));

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? sourceFiles(join(dir, entry.name))
        : entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
          ? [join(dir, entry.name)]
          : [],
    ),
  );
  return nested.flat();
}

/** Fastify's own register options: a stand-in never sets them (a stand-in prefix moves routes). */
const NOT_SPREAD = new Set(["prefix", "logLevel", "logSerializers", "config", "schema"]);

/** Every option name that switches a route module on: a spread stand-in carries all of them. */
let optionNames: string[] = [];

/**
 * A stand-in for any dependency: every property and call returns another stand-in, and an object
 * spread of it keeps every option name, so nested optional routes mount too.
 */
function standIn(name: string, real: Record<string, unknown> = {}): unknown {
  const target = function () {};
  return new Proxy(target, {
    get(_target, key) {
      if (typeof key === "string" && key in real) return real[key];
      if (key === "then") return undefined; // not a promise
      if (key === Symbol.iterator) return function* () {};
      if (key === Symbol.asyncIterator) return async function* () {};
      if (key === Symbol.toPrimitive) return () => `stand-in:${name}`;
      if (key === "toJSON") return () => null;
      if (typeof key === "symbol" || NOT_SPREAD.has(key)) return undefined;
      if (/Origins$/.test(key)) return [];
      return standIn(`${name}.${key}`);
    },
    apply() {
      return standIn(`${name}()`);
    },
    ownKeys(fn) {
      return [...new Set([...Reflect.ownKeys(fn), ...optionNames, ...Object.keys(real)])];
    },
    getOwnPropertyDescriptor(fn, key) {
      const own = Reflect.getOwnPropertyDescriptor(fn, key);
      if (own) return own;
      return typeof key === "string" && (optionNames.includes(key) || key in real)
        ? {
            value: key in real ? real[key] : /Origins$/.test(key) ? [] : standIn(`${name}.${key}`),
            enumerable: true,
            configurable: true,
            writable: true,
          }
        : undefined;
    },
  });
}

const refuse = standIn("refuse") as IdentityRepository;

/** Options with a real value; every other option key gets a stand-in, which mounts its routes. */
const REAL_OPTIONS: Record<string, unknown> = {
  logger: false,
  trustProxy: false,
  databaseHealth: undefined,
  browserAllowedOrigins: [],
  auth: {
    verifier: createFakeVerifier(new Map()),
    repository: refuse,
    rolePermissionRepository: standIn("rolePermissionRepository"),
    entitlementRepository: standIn("entitlementRepository"),
    propertyAccessRepository: standIn("propertyAccessRepository"),
  },
  // Settings some modules check while they register.
  authSession: standIn("authSession", {
    surfacePolicies: {
      "pms-web": { firstPartySession: true, publicOrigin: "https://pms.example.test" },
      "booking-admin": { firstPartySession: true, publicOrigin: "https://admin.example.test" },
      "platform-admin": { firstPartySession: true, publicOrigin: "https://platform.example.test" },
    },
  }),
};

async function collectRouteManifest(): Promise<string[]> {
  const files = await sourceFiles(SOURCE);
  const names = new Set<string>();
  for (const file of files) {
    // Only names that switch something on: `if (options.x)`, `options.x &&`, `options.x ? a : b`.
    // Scalar settings (`options.x ?? "default"`) keep their defaults.
    const text = await readFile(file, "utf8");
    const switches =
      /if\s*\(\s*!?\s*options\.(\w+)\s*[)&|]|\boptions\.(\w+)\s*&&|\boptions\.(\w+)\s*\?(?![?.])/g;
    for (const match of text.matchAll(switches)) {
      const name = match[1] ?? match[2] ?? match[3];
      if (name && !NOT_SPREAD.has(name)) names.add(name);
    }
  }
  optionNames = [...names].sort();
  const options = new Proxy(REAL_OPTIONS, {
    get(target, key) {
      if (typeof key === "symbol") return undefined;
      if (key in target) return target[key];
      if (/Origins$/.test(key)) return [];
      return standIn(key);
    },
    has: () => true,
  });
  const app = buildApp(options as Parameters<typeof buildApp>[0]);
  const routes = new Set<string>();
  app.addHook("onRoute", (route) => {
    for (const method of [route.method].flat()) {
      // Fastify adds a HEAD twin for every GET; it is not a route of its own.
      if (method !== "HEAD") routes.add(`${method} ${route.url}`);
    }
  });
  await app.ready();
  // Some modules close dependencies they got through an object spread, which a stand-in does not
  // survive; the routes are already recorded by then.
  await app.close().catch(() => undefined);
  return [...routes].sort();
}

function render(routes: readonly string[]): string {
  return [
    "// GENERATED by src/ai/routeManifest.test.ts (VAY-2507). Do not edit by hand.",
    "// Every route next-api can mount: the list AI actions are generated from.",
    "// Regenerate: UPDATE_AI_ROUTE_MANIFEST=1 npm --workspace vayada-api run test -- src/ai/routeManifest.test.ts",
    "export const ROUTE_MANIFEST = [",
    ...routes.map((route) => `  ${JSON.stringify(route)},`),
    "] as const;",
    "",
    "export type RouteKey = (typeof ROUTE_MANIFEST)[number];",
    "",
  ].join("\n");
}

/** Routes a route file registers with a literal path, found by reading the source. */
async function staticallyRegisteredRoutes(): Promise<
  { file: string; method: string; path: string }[]
> {
  const found: { file: string; method: string; path: string }[] = [];
  for (const file of await sourceFiles(SOURCE)) {
    if (file.includes(`${join("src", "ai")}`)) continue;
    const text = await readFile(file, "utf8");
    const calls = /\b\w+\.(get|post|put|patch|delete)\s*(?:<[^()]*?>)?\s*\(\s*"(\/[^"]*)"/gs;
    for (const match of text.matchAll(calls)) {
      found.push({ file, method: match[1]!.toUpperCase(), path: match[2]! });
    }
  }
  return found;
}

describe("AI route list (VAY-2507)", () => {
  it("misses no route a route file registers (static cross-check of the collector)", async () => {
    const missing = (await staticallyRegisteredRoutes()).filter(
      ({ method, path }) =>
        !ROUTE_MANIFEST.some((route) => route.startsWith(`${method} `) && route.endsWith(path)),
    );
    expect(missing.map(({ file, method, path }) => `${method} ${path} (${file})`)).toEqual([]);
  });

  it("matches every route the app can mount", async () => {
    const routes = await collectRouteManifest();
    if (process.env.UPDATE_AI_ROUTE_MANIFEST === "1") {
      await writeFile(GENERATED, render(routes));
      return;
    }
    expect(routes.length).toBeGreaterThan(400);
    expect(
      [...ROUTE_MANIFEST],
      "The route list changed: regenerate src/ai/routeManifest.generated.ts (see its header), " +
        "then sort the new routes in src/ai/routeClassification.ts.",
    ).toEqual(routes);
  });
});
