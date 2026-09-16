import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { processNextPmsAcceptedPricingReservationJob } from "./pmsAcceptedPricingReservationWorker.js";
import {
  PMS_ACCEPTED_PRICING_JOB_TYPE,
  PMS_ACCEPTED_PRICING_QUEUE,
} from "./pricingPmsAcceptedReservationJob.js";

const url = process.env["TEST_DATABASE_URL"];

describe.skipIf(!url)("accepted-pricing PMS job concurrency", () => {
  const pool = new pg.Pool({ connectionString: url, max: 3 });
  afterAll(() => pool.end());

  it.each(["malformed-payload", "tenant-envelope-mismatch", "platform-scope"])(
    "lets only one transaction claim a job: %s",
    async (scenario) => {
      if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
        throw new Error("test database required");
      const propertyId = randomUUID();
      const jobId = randomUUID();
      const tenantScope = scenario === "platform-scope" ? "platform" : "property";
      const payload =
        scenario === "malformed-payload"
          ? {}
          : {
              version: "booking.pricing-pms-handoff.v1",
              propertyId,
              guestBookingId: randomUUID(),
              acceptanceId: jobId,
            };
      await pool.query(
        "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,($1::uuid)::text,'Worker lease')",
        [propertyId],
      );
      await pool.query(
        `INSERT INTO platform.jobs
       (id,job_key,queue_name,job_type,tenant_scope,property_id,resource_product,
        resource_type,resource_id,correlation_id,payload)
       VALUES($1::uuid,$2,$3,$4,$5,$6::uuid,'booking',
         'guest_booking',($1::uuid)::text,$1::text,$7::jsonb)`,
        [
          jobId,
          `pms:pricing-acceptance:${jobId}:create:v1`,
          PMS_ACCEPTED_PRICING_QUEUE,
          PMS_ACCEPTED_PRICING_JOB_TYPE,
          tenantScope,
          tenantScope === "property" ? propertyId : null,
          JSON.stringify(payload),
        ],
      );
      const first = await pool.connect();
      const second = await pool.connect();
      try {
        await first.query("BEGIN");
        expect(await processNextPmsAcceptedPricingReservationJob(first, "worker:first")).toBe(
          "dead_lettered",
        );
        await second.query("BEGIN");
        expect(await processNextPmsAcceptedPricingReservationJob(second, "worker:second")).toBe(
          "empty",
        );
        await first.query("COMMIT");
        await second.query("ROLLBACK");
        expect(
          (
            await pool.query(
              `SELECT status,attempts_count,locked_at,locked_by,
              (SELECT count(*)::int FROM platform.job_attempts WHERE job_id=job.id) AS attempts
             FROM platform.jobs job WHERE id=$1`,
              [jobId],
            )
          ).rows,
        ).toEqual([
          {
            status: "dead_lettered",
            attempts_count: 1,
            locked_at: null,
            locked_by: null,
            attempts: 1,
          },
        ]);
        expect(
          (
            await pool.query(
              `SELECT reason_code,tenant_scope,property_id::text AS property_id
               FROM platform.dead_letter_events WHERE job_id=$1`,
              [jobId],
            )
          ).rows,
        ).toEqual([
          {
            reason_code: "invalid_payload",
            tenant_scope: tenantScope,
            property_id: tenantScope === "property" ? propertyId : null,
          },
        ]);
        expect(
          (
            await pool.query(`SELECT action FROM platform.product_audit_events WHERE job_id=$1`, [
              jobId,
            ])
          ).rows,
        ).toEqual([{ action: "accepted_pricing_adoption_dead_lettered" }]);
      } finally {
        await first.query("ROLLBACK");
        await second.query("ROLLBACK");
        first.release();
        second.release();
        await pool.query("BEGIN");
        await pool.query("SET LOCAL session_replication_role=replica");
        await pool.query("DELETE FROM platform.product_audit_events WHERE job_id=$1", [jobId]);
        await pool.query("DELETE FROM platform.dead_letter_events WHERE job_id=$1", [jobId]);
        await pool.query("DELETE FROM platform.job_attempts WHERE job_id=$1", [jobId]);
        await pool.query("DELETE FROM platform.jobs WHERE id=$1", [jobId]);
        await pool.query("DELETE FROM hotel_catalog.properties WHERE id=$1", [propertyId]);
        await pool.query("COMMIT");
      }
    },
  );
});
