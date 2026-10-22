import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// VAY-2205: vayada-admin read NEXT_PUBLIC_PMS_FRONTEND_URL, but its image never got it, so the
// Payments tab linked to the legacy PMS. Next.js inlines NEXT_PUBLIC_* at build time: every one the
// app reads must be a Dockerfile ARG and passed by both of its builds.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const APP = join(ROOT, "apps/vayada-admin");
// Read by the app but left to a reviewed fallback on purpose (the auth API serves platform media).
const FALLBACK_ON_PURPOSE = new Set(["NEXT_PUBLIC_PLATFORM_MEDIA_API_URL"]);

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", ".next", ".github", "public"].includes(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|mjs)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)
      ? [path]
      : [];
  });
}

const readSettings = () =>
  new Set(
    sourceFiles(APP).flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/process\.env\.(NEXT_PUBLIC_[A-Z0-9_]+)/g)].map(
        (match) => match[1],
      ),
    ),
  );

const buildArgs = (text) =>
  new Map(
    [...text.matchAll(/(NEXT_PUBLIC_[A-Z0-9_]+)=([^\s"']+)/g)].map((match) => [match[1], match[2]]),
  );

function coordinatedAdminBuild() {
  const workflow = readFileSync(
    join(ROOT, ".github/workflows/build-coordinated-release.yml"),
    "utf8",
  );
  const start = workflow.indexOf("next-marketplace-admin)");
  assert.ok(start > 0, "the coordinated build has a next-marketplace-admin case");
  return buildArgs(workflow.slice(start, workflow.indexOf(";;", start)));
}

function directAdminBuild() {
  const workflow = readFileSync(
    join(ROOT, ".github/workflows/deploy-next-vayada-admin.yml"),
    "utf8",
  );
  const start = workflow.indexOf("build-args:");
  assert.ok(start > 0, "deploy-next-vayada-admin passes build args");
  return buildArgs(workflow.slice(start, workflow.indexOf("tags:", start)));
}

test("every public setting vayada-admin reads reaches both of its image builds", () => {
  const dockerfile = readFileSync(join(APP, "Dockerfile"), "utf8");
  const coordinated = coordinatedAdminBuild();
  const direct = directAdminBuild();
  const settings = [...readSettings()].filter((name) => !FALLBACK_ON_PURPOSE.has(name)).sort();
  assert.ok(settings.includes("NEXT_PUBLIC_PMS_FRONTEND_URL"));
  for (const name of settings) {
    assert.match(dockerfile, new RegExp(`^ARG ${name}$`, "m"), `${name}: Dockerfile ARG`);
    assert.match(dockerfile, new RegExp(`^ENV ${name}=\\$\\{${name}\\}$`, "m"), `${name}: ENV`);
    assert.ok(coordinated.has(name), `${name}: coordinated release build`);
    assert.ok(direct.has(name), `${name}: deploy-next-vayada-admin`);
  }
});

test("vayada-admin links hotels to the next PMS, not the frozen legacy one", () => {
  for (const build of [coordinatedAdminBuild(), directAdminBuild()]) {
    assert.equal(build.get("NEXT_PUBLIC_PMS_FRONTEND_URL"), "https://next-pms.vayada.com");
  }
});
