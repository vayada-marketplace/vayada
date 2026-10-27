import { createHash } from "node:crypto";
import pg from "pg";

import {
  applyChannexHandover,
  ChannexHandoverRefused,
  planChannexHandover,
  planChannexSales,
  type ChannexHandoverInput,
} from "../channexHandover.js";
import { normalizePgConnectionString } from "../pgConnection.js";

// VAY-2108: target:channex:handover activate|revoke|open-sales|close-sales --property UUID
//   --approval-ref TEXT; activate: --legacy-disabled-at ISO --legacy-readback-sha256 HEX;
//   revoke: --reason TEXT. Without --apply it prints the plan and its sha256 (read only).
//   --apply SHA applies that plan once; re-running it reports replayed=true.
const [command, ...rawArgs] = process.argv.slice(2);

/**
 * The platform runner reads one stdout line below 16 KB. A plan too large for it prints every
 * list as its count and sha256 instead; the plan sha256 still binds the full lists.
 */
function line(value: object) {
  const full = JSON.stringify(value);
  if (Buffer.byteLength(full) <= 15_000) return full;
  return JSON.stringify({ ...value, compacted: true }, (_key, item: unknown) =>
    Array.isArray(item)
      ? {
          count: item.length,
          sha256: createHash("sha256").update(JSON.stringify(item)).digest("hex"),
        }
      : item,
  );
}

try {
  if (
    command !== "activate" &&
    command !== "revoke" &&
    command !== "open-sales" &&
    command !== "close-sales"
  )
    throw new Error("Command must be activate, revoke, open-sales or close-sales");
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
      : command === "revoke"
        ? ["property", "approval-ref", "reason", "apply"]
        : ["property", "approval-ref", "apply"];
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
      : command === "revoke"
        ? {
            command,
            propertyId: value("property"),
            approvalRef: value("approval-ref"),
            reason: value("reason"),
          }
        : { command, propertyId: value("property"), approvalRef: value("approval-ref") };
  const connectionString = process.env["TARGET_DATABASE_URL"];
  if (!connectionString) throw new Error("TARGET_DATABASE_URL is required");
  const pool = new pg.Pool({
    connectionString: normalizePgConnectionString(connectionString),
    max: 1,
  });
  try {
    if (args.has("apply")) {
      const result = await applyChannexHandover(pool, input, value("apply"));
      console.log(line({ applied: true, ...result }));
      console.log(
        `CHANNEX_HANDOVER_COMPLETE action=${command} property=${input.propertyId} planSha256=${result.planSha256} replayed=${result.replayed}`,
      );
    } else {
      const client = await pool.connect();
      try {
        await client.query("BEGIN TRANSACTION READ ONLY");
        const plan =
          input.command === "open-sales" || input.command === "close-sales"
            ? await planChannexSales(client, input)
            : await planChannexHandover(client, input);
        console.log(line({ applied: false, ...plan }));
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
