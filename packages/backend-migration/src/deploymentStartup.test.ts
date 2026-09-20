import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const startupScript = join(__dirname, "../../../scripts/start-next-api.sh");

describe("next-api deployment startup", () => {
  let fakeBin: string;
  let callLog: string;

  beforeEach(async () => {
    fakeBin = await mkdtemp(join(tmpdir(), "next-api-startup-"));
    callLog = join(fakeBin, "calls.log");
    const fakeNpm = join(fakeBin, "npm");
    await writeFile(
      fakeNpm,
      `#!/usr/bin/env sh
case "$TARGET_DATABASE_URL" in
  postgresql://runtime.invalid/target) database_role=runtime ;;
  postgresql://migration-owner.invalid/target) database_role=migration-owner ;;
  *) database_role=unexpected ;;
esac
printf '%s|database_role=%s\\n' "$*" "$database_role" >> "$START_NEXT_API_CALL_LOG"
case "$*" in
  *"@vayada/backend-migration"*) exit "\${FAKE_MIGRATION_EXIT_CODE:-0}" ;;
  *) exit 0 ;;
esac
`,
    );
    await chmod(fakeNpm, 0o755);
    const fakeNode = join(fakeBin, "node");
    await writeFile(
      fakeNode,
      `#!/usr/bin/env sh
if env | grep -F 'postgresql://migration-owner.invalid/target' >/dev/null; then exit 97; fi
printf 'node:%s|target_runtime=%s|auth_runtime=%s|migration=%s|local=%s\n' \
  "$*" \
  "$([ "$TARGET_DATABASE_URL" = 'postgresql://runtime.invalid/target' ] && printf yes || printf no)" \
  "$([ "$AUTH_DATABASE_URL" = 'postgresql://runtime.invalid/target' ] && printf yes || printf no)" \
  "\${TARGET_DATABASE_MIGRATION_URL-unset}" \
  "\${migration_database_url-unset}" >> "$START_NEXT_API_CALL_LOG"
exit 0
`,
    );
    await chmod(fakeNode, 0o755);
  });

  afterEach(async () => {
    await rm(fakeBin, { recursive: true, force: true });
  });

  function runStartup(migrationExitCode: number, migrationUrl?: string) {
    const safeEnvironment = { ...process.env };
    delete safeEnvironment["TARGET_DATABASE_URL"];
    delete safeEnvironment["TARGET_DATABASE_MIGRATION_URL"];
    delete safeEnvironment["AUTH_DATABASE_URL"];
    return spawnSync(startupScript, [], {
      cwd: join(__dirname, "../../.."),
      encoding: "utf8",
      env: {
        ...safeEnvironment,
        APPLICATION_RELEASE: "0123456789abcdef0123456789abcdef01234567",
        TARGET_DATABASE_URL: "postgresql://runtime.invalid/target",
        AUTH_DATABASE_URL: "postgresql://runtime.invalid/target",
        ...(migrationUrl ? { TARGET_DATABASE_MIGRATION_URL: migrationUrl } : {}),
        FAKE_MIGRATION_EXIT_CODE: String(migrationExitCode),
        PATH: `${fakeBin}:${process.env["PATH"] ?? ""}`,
        START_NEXT_API_CALL_LOG: callLog,
      },
    });
  }

  it("starts the API only after the release migration succeeds", async () => {
    const result = runStartup(0);

    expect(result.status, result.stderr).toBe(0);
    expect((await readFile(callLog, "utf8")).trim().split("\n")).toEqual([
      "--workspace @vayada/backend-migration run target:migrate:dist -- --env production --git-sha 0123456789abcdef0123456789abcdef01234567|database_role=runtime",
      "node:dist/server.js|target_runtime=yes|auth_runtime=yes|migration=unset|local=unset",
    ]);
  });

  it("uses a separate owner credential only for migrations", async () => {
    const result = runStartup(0, "postgresql://migration-owner.invalid/target");

    expect(result.status, result.stderr).toBe(0);
    expect((await readFile(callLog, "utf8")).trim().split("\n")).toEqual([
      "--workspace @vayada/backend-migration run target:migrate:dist -- --env production --git-sha 0123456789abcdef0123456789abcdef01234567|database_role=migration-owner",
      "node:dist/server.js|target_runtime=yes|auth_runtime=yes|migration=unset|local=unset",
    ]);
  });

  it("blocks API startup when the release migration fails", async () => {
    const result = runStartup(42);

    expect(result.status).toBe(42);
    expect((await readFile(callLog, "utf8")).trim()).toContain("@vayada/backend-migration");
    expect(await readFile(callLog, "utf8")).not.toContain("node:dist/server.js");
  });
});
