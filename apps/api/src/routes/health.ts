import type { FastifyInstance, FastifyReply } from "fastify";

/** A check still running after this answers with its last result; the ALB gives up after 5 s. */
const ANSWER_WITHIN_MS = 1_000;

export type HealthRouteOptions = {
  /**
   * liveness answers /health, readiness /ready; each resolves false while PostgreSQL is unreachable,
   * readiness also while a shared pool has stopped serving. Unset keeps both routes static.
   */
  databaseHealth?: Readonly<{
    liveness: () => Promise<boolean>;
    readiness: () => Promise<boolean>;
  }>;
  answerWithinMs?: number;
};

export async function registerHealthRoutes(
  app: FastifyInstance,
  options: HealthRouteOptions = {},
): Promise<void> {
  const answerWithinMs = options.answerWithinMs ?? ANSWER_WITHIN_MS;
  const liveness = options.databaseHealth
    ? answering(options.databaseHealth.liveness, answerWithinMs)
    : undefined;
  const readiness = options.databaseHealth
    ? answering(options.databaseHealth.readiness, answerWithinMs)
    : undefined;
  // The ALB checks /health. ECS replaces the task only after the target group's consecutive
  // failure threshold (3 checks 30s apart), so a short database blip recovers in place. A shared
  // pool that stopped serving fails only /ready: replacing the task wouldn't free it (VAY-2247 incident).
  const respond = async (
    reply: FastifyReply,
    status: "ok" | "ready",
    check: (() => Promise<boolean>) | undefined,
  ) => {
    if (!check || (await check())) return { service: "vayada-api", status };
    return reply
      .code(503)
      .send({ service: "vayada-api", status: "unavailable", database: "unavailable" });
  };

  app.get("/health", async (_request, reply) => respond(reply, "ok", liveness));
  app.get("/ready", async (_request, reply) => respond(reply, "ready", readiness));
}

/** Answers within answerMs: with the check's result, or with its last one while it still runs. */
function answering(check: () => Promise<boolean>, answerMs: number): () => Promise<boolean> {
  let last = true;
  return async () => {
    let timer: NodeJS.Timeout | undefined;
    const result = check().then(
      (healthy) => {
        last = healthy;
        return healthy;
      },
      () => {
        last = false;
        return false;
      },
    );
    const late = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(last), answerMs);
    });
    try {
      return await Promise.race([result, late]);
    } finally {
      clearTimeout(timer);
    }
  };
}
