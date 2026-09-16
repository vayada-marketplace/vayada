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

  it("lets only one transaction claim a job", async () => {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
      throw new Error("test database required");
    const propertyId = randomUUID();
    const jobId = randomUUID();
    await pool.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,($1::uuid)::text,'Worker lease')",
      [propertyId],
    );
    await pool.query(
      `INSERT INTO platform.jobs
       (id,job_key,queue_name,job_type,tenant_scope,property_id,resource_product,
        resource_type,resource_id,payload)
       VALUES($1::uuid,'worker-lease',$2,$3,'property',$4,'pms',
         'accepted_pricing_reservation',($1::uuid)::text,'{}')`,
      [jobId, PMS_ACCEPTED_PRICING_QUEUE, PMS_ACCEPTED_PRICING_JOB_TYPE, propertyId],
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
    } finally {
      await first.query("ROLLBACK");
      await second.query("ROLLBACK");
      first.release();
      second.release();
      await pool.query("DELETE FROM platform.job_attempts WHERE job_id=$1", [jobId]);
      await pool.query("DELETE FROM platform.jobs WHERE id=$1", [jobId]);
      await pool.query("DELETE FROM hotel_catalog.properties WHERE id=$1", [propertyId]);
    }
  });
});
