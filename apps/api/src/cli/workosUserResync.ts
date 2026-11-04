#!/usr/bin/env node
import { NotFoundException, WorkOS } from "@workos-inc/node";
import pg from "pg";

import {
  applyWorkosUserResync,
  parseWorkosUserResyncArgs,
  planWorkosUserResync,
  summarizeWorkosUserResyncPlan,
  WorkosUserResyncRefusal,
  type WorkosUserReader,
} from "../platform/workosUserResync.js";

// VAY-2479: re-read the users whose WorkOS user webhooks were dead-lettered and apply the
// webhook's own update. Without --apply it is a dry run: it reads only and prints the plan and
// its SHA-256. With --apply <plan sha256> it re-plans and refuses unless the SHA is the same.
// It runs as the identity login, like the webhook. Output holds no names or emails.
// Exit codes: 0 done, 64 refused, 1 failed.
const IDENTITY_LOGIN = "vayada_next_identity_runtime";

const print = (line: Record<string, unknown>, stream: NodeJS.WriteStream = process.stdout) =>
  stream.write(`${JSON.stringify(line)}\n`);

async function main(): Promise<number> {
  const { approvalRef, applyPlanSha256 } = parseWorkosUserResyncArgs(process.argv.slice(2));
  const databaseUrl = process.env["AUTH_DATABASE_URL"];
  const apiKey = process.env["WORKOS_API_KEY"];
  if (!databaseUrl || !apiKey) throw new WorkosUserResyncRefusal("environment_missing");

  const workosClient = new WorkOS(apiKey);
  const workos: WorkosUserReader = {
    async getUser(workosUserId) {
      try {
        return { ...(await workosClient.userManagement.getUser(workosUserId)) };
      } catch (error) {
        if (error instanceof NotFoundException) return null;
        throw error;
      }
    },
  };
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const login = await pool.query<{ login: string }>("SELECT current_user AS login");
    if (login.rows[0]?.login !== IDENTITY_LOGIN) {
      throw new WorkosUserResyncRefusal("identity_login_required");
    }
    if (applyPlanSha256 === null) {
      const plan = await planWorkosUserResync({ pool, workos });
      print({
        planSha256: plan.planSha256,
        applied: false,
        approvalRef,
        plan: summarizeWorkosUserResyncPlan(plan),
      });
      return 0;
    }
    const result = await applyWorkosUserResync({
      pool,
      workos,
      planSha256: applyPlanSha256,
      approvalRef,
    });
    print({ planSha256: applyPlanSha256, applied: true, approvalRef, result });
    process.stdout.write(
      `WORKOS_USER_RESYNC_COMPLETE planSha256=${applyPlanSha256}` +
        ` updated=${result.usersUpdated} resolved=${result.deadLettersResolved}` +
        ` acknowledged=${result.deadLettersAcknowledged} skipped=${result.usersSkipped}\n`,
    );
    return 0;
  } finally {
    await pool.end();
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof WorkosUserResyncRefusal) {
    print({ status: "REFUSED", code: error.code }, process.stderr);
    process.exitCode = 64;
  } else {
    // Error names and codes only: database and WorkOS messages can carry personal data.
    const code = (error as { code?: unknown } | null)?.code;
    print(
      {
        status: "FAILED",
        error: error instanceof Error ? error.name : "unknown",
        code: typeof code === "string" ? code : undefined,
      },
      process.stderr,
    );
    process.exitCode = 1;
  }
}
