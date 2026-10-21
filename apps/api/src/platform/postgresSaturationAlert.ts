import { createHash } from "node:crypto";

import type { BookingEmailDelivery } from "../jobs/bookingEmailDelivery.js";
import type { PostgresSaturationEpisode } from "./postgresRuntime.js";

const HOUR_MS = 60 * 60 * 1000;

/**
 * VAY-2247 incident (2026-10-21): emails the ops recipient (the pricing alert's) when requests on an API
 * task have waited for a database connection for 30 s without a break. At most once an hour per task;
 * a failed send is tried again on the next episode. Sending needs no database connection.
 */
export function createPostgresSaturationAlert(options: {
  to: string;
  delivery: Pick<BookingEmailDelivery, "send">;
  now?: () => Date;
}) {
  let lastSentAt: number | undefined;
  return async (episode: PostgresSaturationEpisode): Promise<boolean> => {
    const now = options.now?.() ?? new Date();
    if (lastSentAt !== undefined && now.getTime() - lastSentAt < HOUR_MS) return false;
    lastSentAt = now.getTime();
    const at = now.toISOString().slice(0, 16).replace("T", " ");
    const text = [
      `At ${at} UTC, requests on one next-api task had been waiting for a database connection for ${Math.round(episode.durationMs / 1000)} s without a break.`,
      "While this lasts, pages load slowly or fail, and sign-ins can hang.",
      "",
      `Connections in use: ${episode.totalConnections - episode.idleConnections} of ${episode.maxConnections} (${episode.physicalPoolCount} pools).`,
      `Requests waiting: ${episode.waitingRequests}. Pools that stopped handing out connections: ${episode.stalledPools}.`,
      "",
      'Details are in the next-api log lines "PostgreSQL runtime pool saturated for 30 s" and "PostgreSQL runtime pool is saturated".',
      "This email is sent at most once an hour per API task.",
    ].join("\n");
    try {
      await options.delivery.send({
        to: options.to,
        subject: "Vayada: the API is waiting for database connections",
        text,
        idempotencyKey: `postgres-pool-saturation:${createHash("sha256").update(text).digest("hex").slice(0, 32)}`,
        // VAY-2293: the Resend webhook acknowledges platform events instead of retrying them.
        emailProduct: "platform",
      });
    } catch (error) {
      lastSentAt = undefined;
      throw error;
    }
    return true;
  };
}
