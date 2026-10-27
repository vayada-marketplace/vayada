import pg from "pg";

import {
  applyChannexHandover,
  ChannexHandoverRefused,
  planChannexHandover,
  type ChannexHandoverInput,
} from "../channexHandover.js";
import { normalizePgConnectionString } from "../pgConnection.js";

// VAY-2108: target:channex:handover activate|revoke --property UUID --approval-ref TEXT
//   activate: --legacy-disabled-at ISO --legacy-readback-sha256 HEX
//   revoke:   --reason TEXT
// Without --apply it prints the plan and its sha256 (read only). --apply SHA applies that plan.
const [command, ...rawArgs] = process.argv.slice(2);

try {
  if (command !== "activate" && command !== "revoke")
    throw new Error("Command must be activate or revoke");
  const args = new Map<string, string>();
  for (let index = 0; index < rawArgs.length; index += 2) {
    const [key, value] = [rawArgs[index], rawArgs[index + 1]];
    if (
      !key?.startsWith("--") ||
      value === undefined ||
      value.startsWith("--") ||
      args.has(key.slice(2))
    )
      throw new Error("Arguments must be unique --name value pairs");
    args.set(key.slice(2), value);
  }
  const allowed =
    command === "activate"
      ? ["property", "approval-ref", "legacy-disabled-at", "legacy-readback-sha256", "apply"]
      : ["property", "approval-ref", "reason", "apply"];
  for (const name of args.keys())
    if (!allowed.includes(name)) throw new Error(`Unknown argument --${name}`);
  const value = (name: string) => args.get(name) ?? "";
  const input: ChannexHandoverInput =
    command === "activate"
      ? {
          command,
          propertyId: value("property"),
          approvalRef: value("approval-ref"),
          legacyDisabledAt: value("legacy-disabled-at"),
          legacyReadbackSha256: value("legacy-readback-sha256"),
        }
      : {
          command,
          propertyId: value("property"),
          approvalRef: value("approval-ref"),
          reason: value("reason"),
        };
  const connectionString = process.env["TARGET_DATABASE_URL"];
  if (!connectionString) throw new Error("TARGET_DATABASE_URL is required");
  const pool = new pg.Pool({
    connectionString: normalizePgConnectionString(connectionString),
    max: 1,
  });
  try {
    if (args.has("apply")) {
      const result = await applyChannexHandover(pool, input, value("apply"));
      console.log(JSON.stringify({ applied: true, ...result }));
    } else {
      const client = await pool.connect();
      try {
        await client.query("BEGIN TRANSACTION READ ONLY");
        console.log(
          JSON.stringify({ applied: false, ...(await planChannexHandover(client, input)) }),
        );
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
} catch (error) {
  const code =
    error instanceof ChannexHandoverRefused
      ? `refused: ${error.message}`
      : error instanceof Error
        ? error.message
        : "Channex handover failed";
  console.error(`Error: ${code}`);
  process.exitCode = 1;
}
