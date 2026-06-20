#!/usr/bin/env node
import {
  PLATFORM_BOOTSTRAP_CONFIRM,
  runPlatformIdentityBootstrap,
  type PlatformIdentityBootstrapMode,
} from "../platformIdentityBootstrap.js";

function parseArgs(argv: string[]): {
  mode: PlatformIdentityBootstrapMode;
  targetConnectionString: string;
  legacyAuthConnectionString: string;
  confirm: string;
} {
  const args = argv.slice(2);
  let mode: PlatformIdentityBootstrapMode = "dry-run";
  let targetConnectionString = process.env["TARGET_DATABASE_URL"] ?? "";
  let legacyAuthConnectionString = process.env["LEGACY_AUTH_DATABASE_URL"] ?? "";
  let confirm = "";
  let explicitMode: PlatformIdentityBootstrapMode | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") {
      if (explicitMode === "apply") {
        console.error("Error: --dry-run and --apply are mutually exclusive.");
        process.exit(1);
      }
      explicitMode = "dry-run";
      mode = "dry-run";
    } else if (arg === "--apply") {
      if (explicitMode === "dry-run") {
        console.error("Error: --dry-run and --apply are mutually exclusive.");
        process.exit(1);
      }
      explicitMode = "apply";
      mode = "apply";
    } else if (arg === "--target-connection-string" && args[i + 1]) {
      targetConnectionString = args[++i];
    } else if (arg === "--legacy-auth-connection-string" && args[i + 1]) {
      legacyAuthConnectionString = args[++i];
    } else if (arg === "--confirm" && args[i + 1]) {
      confirm = args[++i];
    }
  }

  return { mode, targetConnectionString, legacyAuthConnectionString, confirm };
}

const { mode, targetConnectionString, legacyAuthConnectionString, confirm } = parseArgs(
  process.argv,
);

if (!targetConnectionString) {
  console.error("Error: TARGET_DATABASE_URL or --target-connection-string is required.");
  process.exit(1);
}
if (!legacyAuthConnectionString) {
  console.error("Error: LEGACY_AUTH_DATABASE_URL or --legacy-auth-connection-string is required.");
  process.exit(1);
}
if (mode === "apply" && confirm !== PLATFORM_BOOTSTRAP_CONFIRM) {
  console.error(`Error: --apply requires --confirm ${PLATFORM_BOOTSTRAP_CONFIRM}.`);
  process.exit(1);
}

const summary = await runPlatformIdentityBootstrap({
  mode,
  targetConnectionString,
  legacyAuthConnectionString,
});
console.log(JSON.stringify(summary, null, 2));
