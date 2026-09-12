import type pg from "pg";
import {
  loadNoShowEligibility,
  noShowIneligibility,
  noShowAudit,
  NO_SHOW_QUEUE,
  type ReportJob,
} from "../domains/pmsNoShowReporting.js";

type ProviderConfig = { apiBaseUrl: string; apiKey: string; fetch?: typeof fetch };
export async function runNoShowReport(
  pool: pg.Pool,
  config: ProviderConfig,
  workerId: string,
  propertyId?: string,
) {
  if (
    propertyId !== undefined &&
    (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(propertyId) ||
      config.apiBaseUrl !== "https://staging.channex.io")
  ) {
    throw new Error("Scoped no-show worker requires a property UUID and exact staging URL");
  }
  const db = await pool.connect();
  let job: ReportJob | undefined;
  try {
    await db.query("BEGIN");
    job = (
      await db.query<ReportJob>(
        `SELECT * FROM platform.jobs WHERE queue_name=$1 AND ($2::uuid IS NULL OR property_id=$2::uuid) AND
      ((status='pending' AND run_after<=now()) OR (status='running' AND locked_at<now()-interval '5 minutes'))
      ORDER BY run_after FOR UPDATE SKIP LOCKED LIMIT 1`,
        [NO_SHOW_QUEUE, propertyId ?? null],
      )
    ).rows[0];
    if (!job) {
      await db.query("COMMIT");
      return;
    }
    if (job.status === "running" || job.job_metadata.dispatchStarted) {
      await finish(
        db,
        job,
        "Worker stopped before its outcome was saved. Check the Booking.com extranet before further action.",
        !job.job_metadata.dispatchStarted,
        false,
      );
      await db.query("COMMIT");
      return;
    }
    job = (
      await db.query<ReportJob>(
        `UPDATE platform.jobs SET status='running',attempts_count=attempts_count+1,locked_at=now(),locked_by=$2,updated_at=now() WHERE id=$1 RETURNING *`,
        [job.id, workerId],
      )
    ).rows[0]!;
    await db.query(
      "INSERT INTO platform.job_attempts(job_id,attempt_number,status,worker_id) VALUES($1,$2,'running',$3)",
      [job.id, job.attempts_count, workerId],
    );
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
  if (!job) return;
  let reason: string | null = null,
    retryable = false,
    dispatched = false;
  try {
    const row = await loadNoShowEligibility(pool, job.property_id, job.resource_id);
    reason = row ? noShowIneligibility(row) : "Reservation no longer exists.";
    if (
      !reason &&
      row &&
      (row.noShows !== row.roomCount ||
        row.externalBookingId !== job.payload.externalBookingId ||
        row.externalPropertyId !== job.payload.externalPropertyId ||
        row.bindingGeneration !== job.payload.bindingGeneration)
    )
      reason = "Reservation state or provider mapping changed. Review in the extranet.";
    if (!reason && row) {
      const request = async (method: "GET" | "POST") =>
        (config.fetch ?? fetch)(
          `${config.apiBaseUrl.replace(/\/$/, "")}/api/v1/bookings/${encodeURIComponent(job!.payload.externalBookingId)}${method === "POST" ? "/no_show" : ""}`,
          {
            method,
            headers: { "user-api-key": config.apiKey, "content-type": "application/json" },
            signal: AbortSignal.timeout(30_000),
            ...(method === "POST"
              ? {
                  body: JSON.stringify({
                    no_show_report: { waived_fees: job!.payload.waivedFees },
                  }),
                }
              : {}),
          },
        );
      const live = await request("GET");
      if (!live.ok) {
        reason = `Provider eligibility check failed (HTTP ${live.status}).`;
        retryable = live.status === 429 || live.status >= 500;
      } else {
        const body = (await live.json()) as {
          data?: { id?: string; attributes?: Record<string, unknown> };
        };
        reason = providerNoShowIneligibility(body, job, row.checkIn, row.checkOut, row.roomCount);
        if (!reason) {
          const locked = await pool.connect();
          try {
            await locked.query("BEGIN");
            await locked.query(
              "SELECT id FROM pms.channel_connections WHERE property_id=$1 AND provider='channex' FOR SHARE",
              [job.property_id],
            );
            await locked.query(
              "SELECT id FROM pms.channel_binding_claims WHERE property_id=$1 AND provider='channex' FOR SHARE",
              [job.property_id],
            );
            await locked.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
              `channex-booking:${job.property_id}:${job.payload.externalBookingId}`,
            ]);
            await locked.query(
              "SELECT id FROM booking.guest_bookings WHERE property_id=$1 AND id=$2 FOR SHARE",
              [job.property_id, job.resource_id],
            );
            await locked.query(
              "SELECT id FROM pms.operational_booking_assignments WHERE property_id=$1 AND guest_booking_id=$2 FOR SHARE",
              [job.property_id, job.resource_id],
            );
            await locked.query(
              "SELECT property_id FROM hotel_catalog.property_locations WHERE property_id=$1 FOR SHARE",
              [job.property_id],
            );
            const fresh = await loadNoShowEligibility(locked, job.property_id, job.resource_id);
            const freshReason = fresh
              ? noShowIneligibility(fresh)
              : "Reservation no longer exists.";
            if (
              freshReason ||
              !fresh ||
              fresh.noShows !== fresh.roomCount ||
              fresh.externalBookingId !== job.payload.externalBookingId ||
              fresh.externalPropertyId !== job.payload.externalPropertyId ||
              fresh.bindingGeneration !== job.payload.bindingGeneration ||
              fresh.checkIn !== row.checkIn ||
              fresh.checkOut !== row.checkOut ||
              fresh.roomCount !== row.roomCount
            ) {
              reason =
                freshReason ??
                "Reservation or provider mapping changed during eligibility verification. Review in the extranet.";
            } else {
              // Commit before POST. Losing the response or process can never erase dispatch evidence.
              const fenced = await pool.query(
                `UPDATE platform.jobs SET job_metadata=job_metadata||'{"dispatchStarted":true}'::jsonb,locked_at=now(),updated_at=now()
            WHERE id=$1 AND status='running' AND locked_by=$2 AND attempts_count=$3 RETURNING id`,
                [job.id, workerId, job.attempts_count],
              );
              if (!fenced.rowCount) throw new Error("Report lease lost before dispatch");
              dispatched = true;
              const response = await request("POST");
              if (response.status === 429) {
                reason = "Channex rate limited the report. Delivery can be retried.";
                retryable = true;
                dispatched = false;
              } else if (!response.ok)
                reason =
                  response.status >= 500
                    ? `Provider outcome unknown (HTTP ${response.status}). Check the extranet; do not resubmit.`
                    : `Provider rejected the report (HTTP ${response.status}). Resolve it in the Booking.com extranet.`;
              else {
                const result = (await response.json()) as { meta?: { message?: unknown } };
                if (result.meta?.message !== "Success")
                  reason =
                    "Provider response did not confirm submission. Check the extranet; do not resubmit.";
              }
            }
            await locked.query("COMMIT");
          } catch (error) {
            await locked.query("ROLLBACK");
            throw error;
          } finally {
            locked.release();
          }
        }
      }
    }
  } catch {
    reason = dispatched
      ? "Provider outcome unknown. Check the Booking.com extranet; do not resubmit."
      : "Provider eligibility check could not complete. Delivery can be retried.";
    retryable = !dispatched;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const owned = await client.query(
      "SELECT id FROM platform.jobs WHERE id=$1 AND status='running' AND locked_by=$2 AND attempts_count=$3 FOR UPDATE",
      [job.id, workerId, job.attempts_count],
    );
    if (owned.rowCount) {
      job.job_metadata = { ...job.job_metadata, dispatchStarted: dispatched };
      await finish(client, job, reason, retryable, true);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export function providerNoShowIneligibility(
  body: { data?: { id?: string; attributes?: Record<string, unknown> } },
  job: ReportJob,
  checkIn: string,
  checkOut: string,
  rooms: number,
) {
  const b = body.data?.attributes;
  if (
    body.data?.id !== job.payload.externalBookingId ||
    b?.property_id !== job.payload.externalPropertyId ||
    typeof b.ota_name !== "string" ||
    b.ota_name.replace(/[^a-z0-9]/gi, "").toLowerCase() !== "bookingcom"
  )
    return "Provider reservation identity or source does not match. Review in the extranet.";
  if (
    !["new", "modified"].includes(String(b.status)) ||
    b.arrival_date !== checkIn ||
    b.departure_date !== checkOut ||
    !Array.isArray(b.rooms) ||
    b.rooms.length !== rooms
  )
    return "Provider reservation state or rooms changed. Partial no-shows require the extranet.";
  return null;
}
async function finish(
  db: Pick<pg.Pool, "query">,
  job: ReportJob,
  reason: string | null,
  retryable: boolean,
  automatic: boolean,
) {
  const retry = reason && retryable && automatic && job.attempts_count < job.max_attempts;
  const status = !reason ? "succeeded" : retry ? "pending" : "dead_lettered";
  const metadata = {
    ...job.job_metadata,
    reason:
      reason ??
      "Submitted to Channex. Confirm Booking.com reporting in the extranet; submission is not OTA confirmation.",
    retryable,
  };
  await db.query(
    `UPDATE platform.jobs SET status=$2,job_metadata=$3::jsonb,finished_at=CASE WHEN $2='pending' THEN NULL ELSE now() END,locked_at=NULL,locked_by=NULL,
    run_after=now()+($4::int * interval '1 second'),updated_at=now() WHERE id=$1`,
    [job.id, status, JSON.stringify(metadata), Math.min(60, 2 ** job.attempts_count)],
  );
  await db.query(
    `UPDATE platform.job_attempts SET status=$3,finished_at=now(),error_type=$4,error_message=$5,error_metadata=$6::jsonb WHERE job_id=$1 AND attempt_number=$2 AND status='running'`,
    [
      job.id,
      job.attempts_count,
      !reason ? "succeeded" : "failed",
      !reason ? null : retryable ? "retryable_provider_failure" : "action_required",
      reason,
      JSON.stringify(metadata),
    ],
  );
  job.job_metadata = metadata;
  await noShowAudit(db, job, !reason ? "submitted" : retry ? "retry_scheduled" : "action_required");
}
