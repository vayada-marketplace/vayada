import { readFile } from "node:fs/promises";
import pg from "pg";

import { consumeSignedChannexAdoptionManifest } from "../channexAdoptionConsumer.js";
import { rollbackChannexAdoption } from "../channexAdoptionRollback.js";
import { parseChannexAdoptionRunnerConfig } from "../channexAdoptionRunnerConfig.js";

const [command, ...rawArgs] = process.argv.slice(2);

try {
  if (command !== "consume" && command !== "rollback")
    throw new Error("Command must be consume or rollback");
  const args = parseArgs(rawArgs);
  assertAllowedArgs(
    args,
    command === "consume"
      ? ["config", "manifest-file", "signature-file"]
      : command === "rollback"
        ? ["config", "manifest-id", "reason-file", "expires-at", "approval-record-ids"]
        : [],
  );
  const connectionString = process.env["TARGET_DATABASE_URL"];
  const executionPrincipal = process.env["CHANNEX_ADOPTION_EXECUTION_PRINCIPAL"];
  if (!connectionString) throw new Error("TARGET_DATABASE_URL is required");
  if (!executionPrincipal) throw new Error("CHANNEX_ADOPTION_EXECUTION_PRINCIPAL is required");
  const config = parseChannexAdoptionRunnerConfig(
    await readFile(required(args, "config"), "utf8"),
    executionPrincipal,
  );
  const pool = new pg.Pool({ connectionString, max: 4 });
  try {
    if (command === "consume") {
      const raw = await readFile(required(args, "manifest-file"), "utf8");
      const detachedSignature = (await readFile(required(args, "signature-file"), "utf8")).trim();
      const result = await consumeSignedChannexAdoptionManifest(
        pool,
        { raw, detachedSignature },
        config,
      );
      console.log(JSON.stringify(result));
    } else if (command === "rollback") {
      const reason = await readFile(required(args, "reason-file"), "utf8");
      if (!reason.trim()) throw new Error("Rollback reason file must not be empty");
      const approvals = required(args, "approval-record-ids").split(",");
      if (approvals.length !== 2)
        throw new Error("Exactly two rollback approval record IDs are required");
      const result = await rollbackChannexAdoption(
        pool,
        {
          manifestId: required(args, "manifest-id"),
          reason,
          expiresAt: required(args, "expires-at"),
          approvalRecordIds: approvals as [string, string],
        },
        config,
      );
      console.log(JSON.stringify(result));
    }
  } finally {
    await pool.end();
  }
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : "Channex adoption failed"}`);
  process.exitCode = 1;
}

function parseArgs(values: string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--"))
      throw new Error("Arguments must be --name value pairs");
    const name = key.slice(2);
    if (args.has(name)) throw new Error(`Duplicate argument --${name}`);
    args.set(name, value);
  }
  return args;
}

function required(args: ReadonlyMap<string, string>, key: string): string {
  const value = args.get(key);
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

function assertAllowedArgs(args: ReadonlyMap<string, string>, allowed: readonly string[]): void {
  for (const key of args.keys())
    if (!allowed.includes(key)) throw new Error(`Unknown argument --${key}`);
}
