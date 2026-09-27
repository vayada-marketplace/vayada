#!/usr/bin/env node
// VAY-1138: one property, three immutable Channex room-night roots. Dry run by default.
import { createHash } from "node:crypto";
import pg from "pg";

const PROPERTY = "65f6b2fc-c783-4963-9d6b-a85f82319769";
const APPROVED_RELEASE = "f0fdc908f9d30468beca555f8b90b884888f14fa";
const EVIDENCE = [
  "501d6763-3c14-48d9-a7d5-2b6615816d26",
  "5a9bdc83-14f9-4e35-a07c-fa161d5c2112",
  "8d73d6da-8030-4788-8ff2-5be801084e24",
];
const mode = process.env.VAY1138_MODE ?? "dry_run";
const apply = mode !== "dry_run";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const assert = (condition, code) => {
  if (!condition) throw new Error(code);
};

assert(["dry_run", "rollback_capture", "commit_capture"].includes(mode), "mode_untrusted");
assert(
  apply
    ? process.env.VAY1138_APPLY_PROPERTY_ID === PROPERTY
    : !process.env.VAY1138_APPLY_PROPERTY_ID,
  "apply_property_mismatch",
);
assert(process.env.TARGET_DATABASE_URL && process.env.VAYADA_DB_RDS_CA_BUNDLE, "connection_missing");
const url = new URL(process.env.TARGET_DATABASE_URL);
assert(
  url.protocol === "postgresql:" &&
    url.hostname === "vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com" &&
    url.port === "5432" &&
    url.pathname === "/vayada_target_prod" &&
    decodeURIComponent(url.username) === "vayada_target_prod_user" &&
    url.search === "?sslmode=require" &&
    !url.hash &&
    !!url.password,
  "endpoint_untrusted",
);
if (apply)
  assert(
    process.env.VAY1138_APPROVED_RELEASE === APPROVED_RELEASE &&
      process.env.APPLICATION_RELEASE === APPROVED_RELEASE,
    "reviewed_release_required",
  );
url.search = "";
const client = new pg.Client({
  connectionString: url.toString(),
  ssl: { ca: process.env.VAYADA_DB_RDS_CA_BUNDLE, rejectUnauthorized: true, servername: url.hostname },
  connectionTimeoutMillis: 10_000,
});

let stage = "connect";
try {
  await client.connect();
  await client.query(apply ? "BEGIN" : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s'");
  assert(
    (await client.query("SHOW transaction_read_only")).rows[0]?.transaction_read_only ===
      (apply ? "off" : "on"),
    "transaction_mode_mismatch",
  );

  stage = "property_profile";
  const profile = (
    await client.query(
      `SELECT location.timezone AS "timeZone", property.profile_revision::text AS revision
       FROM hotel_catalog.properties property
       JOIN hotel_catalog.property_locations location ON location.property_id=property.id
       WHERE property.id=$1::uuid
         AND EXISTS(SELECT 1 FROM pms.operating_calendar_revisions calendar
           WHERE calendar.property_id=property.id
             AND calendar.calendar_revision=(SELECT max(calendar_revision)
               FROM pms.operating_calendar_revisions WHERE property_id=property.id)
             AND calendar.property_profile_revision=property.profile_revision
             AND calendar.property_time_zone=location.timezone)
       ${apply ? "FOR UPDATE OF property" : ""}`,
      [PROPERTY],
    )
  ).rows;
  assert(profile.length === 1, "property_timezone_or_calendar_drift");
  const propertyTimezone = {
    source: {
      ownerDomain: "hotel_catalog",
      entityType: "property_profile",
      entityId: PROPERTY,
      revision: `profile:${profile[0].revision}`,
    },
    timeZone: profile[0].timeZone,
  };

  stage = "exact_roots";
  const roots = (
    await client.query(
      `SELECT night.id::text AS id, night.guest_booking_id::text AS "bookingId",
         night.stay_date::text AS "serviceNight", night.command_key AS "commandKey",
         night.gross_room_amount::text AS gross, night.source_kind AS "sourceKind",
         night.economic_event AS "economicEvent", night.evidence_quality AS quality,
         night.corrects_evidence_id::text AS "correctsId",
         booking.source_system AS "sourceSystem", booking.booking_channel AS channel,
         booking.source_booking_id AS "sourceBookingId", attribution.booking_channel AS "attributedChannel"
       FROM booking.nightly_revenue_evidence night
       JOIN booking.guest_bookings booking ON booking.id=night.guest_booking_id
         AND booking.property_id=night.property_id
       JOIN booking.finance_booking_attribution attribution
         ON attribution.guest_booking_id=night.guest_booking_id
         AND attribution.property_id=night.property_id
       WHERE night.property_id=$1::uuid AND night.id=ANY($2::uuid[])
       ORDER BY night.id ${apply ? "FOR SHARE OF night, booking" : ""}`,
      [PROPERTY, EVIDENCE],
    )
  ).rows;
  assert(roots.length === EVIDENCE.length, "exact_roots_changed");
  for (const root of roots) {
    assert(
      EVIDENCE.includes(root.id) &&
        root.sourceKind === "ota" &&
        root.economicEvent === "room_night" &&
        root.quality === "exact" &&
        root.correctsId === null &&
        root.gross !== null &&
        root.sourceSystem === "pms" &&
        root.channel === "booking_com" &&
        root.attributedChannel === "booking_com" &&
        root.sourceBookingId?.startsWith("channex:"),
      "root_identity_drift",
    );
    const mappings = (
      await client.query(
        `SELECT external_booking_id AS "bookingId", external_revision_id AS "revisionId"
         FROM pms.channel_booking_mappings
         WHERE property_id=$1::uuid AND guest_booking_id=$2::uuid`,
        [PROPERTY, root.bookingId],
      )
    ).rows;
    assert(mappings.length === 1, "channex_mapping_drift");
    const key = `channex:${mappings[0].bookingId}:${mappings[0].revisionId}:nightly-revenue:primary:0:v1`;
    assert(root.commandKey?.startsWith(`external:${hash(key)}:`), "channex_command_drift");
  }

  stage = "evidence_and_rules";
  const gaps = (
    await client.query(
      `SELECT night.id::text AS id
       FROM booking.nightly_revenue_evidence night
       JOIN booking.finance_booking_attribution attribution
         ON attribution.guest_booking_id=night.guest_booking_id
         AND attribution.property_id=night.property_id
       LEFT JOIN finance.ota_commission_evidence commission
         ON commission.booking_revenue_evidence_id=night.id
       WHERE night.property_id=$1::uuid AND night.source_kind='ota'
         AND attribution.booking_channel IN ('booking_com','airbnb','expedia','agoda','other_ota')
         AND commission.id IS NULL ORDER BY night.id`,
      [PROPERTY],
    )
  ).rows.map((row) => row.id);
  assert(JSON.stringify(gaps) === JSON.stringify([...EVIDENCE].sort()), "ota_gap_set_drift");
  const descendants = await client.query(
    `SELECT count(*)::int AS count FROM booking.nightly_revenue_evidence
     WHERE property_id=$1::uuid AND corrects_evidence_id=ANY($2::uuid[])`,
    [PROPERTY, EVIDENCE],
  );
  assert(descendants.rows[0].count === 0, "revenue_correction_drift");
  for (const root of roots) {
    const rules = await client.query(
      `SELECT count(*)::int AS count FROM finance.commission_rules
       WHERE property_id=$1::uuid AND ota_channel='booking_com'
         AND starts_at<=($2::date::timestamp AT TIME ZONE $3)
         AND (ends_at IS NULL OR ($2::date::timestamp AT TIME ZONE $3)<ends_at)`,
      [PROPERTY, root.serviceNight, profile[0].timeZone],
    );
    assert(rules.rows[0].count === 0, "commission_rule_drift");
  }
  const audit = await client.query(
    `SELECT count(*)::int AS count FROM platform.product_audit_events
     WHERE property_id=$1::uuid AND target_resource_type='ota_commission_rule'`,
    [PROPERTY],
  );
  assert(audit.rows[0].count === 0, "commission_rule_audit_drift");
  const rateChanges = await client.query(
    `SELECT count(*)::int AS count FROM finance.commission_rate_changes change
     JOIN finance.commission_rules rule ON rule.id=change.commission_rule_id
     WHERE rule.property_id=$1::uuid`,
    [PROPERTY],
  );
  assert(rateChanges.rows[0].count === 0, "commission_rate_change_drift");

  if (apply) {
    stage = "capture";
    const { captureFinanceOtaCommissionEvidence } = await import(
      "/app/apps/api/dist/domains/financeOtaCommissionEvidence.js"
    );
    for (const id of EVIDENCE) {
      const result = await captureFinanceOtaCommissionEvidence(client, {
        propertyId: PROPERTY,
        bookingRevenueEvidenceId: id,
        propertyTimezone,
      });
      assert(
        result.outcome === "captured" &&
          result.evidence.evidenceState === "missing_rule" &&
          result.evidence.percentageRate === null &&
          result.evidence.commissionAmount === null,
        "capture_result_drift",
      );
    }
    const inserted = await client.query(
      `SELECT count(*)::int AS count FROM finance.ota_commission_evidence
       WHERE property_id=$1::uuid AND booking_revenue_evidence_id=ANY($2::uuid[])
         AND evidence_state='missing_rule' AND percentage_rate IS NULL
         AND commission_amount IS NULL`,
      [PROPERTY, EVIDENCE],
    );
    assert(inserted.rows[0].count === EVIDENCE.length, "postflight_drift");
    await client.query(mode === "commit_capture" ? "COMMIT" : "ROLLBACK");
    if (mode === "rollback_capture") {
      const persisted = await client.query(
        `SELECT count(*)::int AS count FROM finance.ota_commission_evidence
         WHERE property_id=$1::uuid AND booking_revenue_evidence_id=ANY($2::uuid[])`,
        [PROPERTY, EVIDENCE],
      );
      assert(persisted.rows[0].count === 0, "rollback_persisted_rows");
    }
  } else {
    await client.query("ROLLBACK");
  }
  console.log(
    JSON.stringify({
      status: "PASS",
      mode,
      propertyId: PROPERTY,
      exactEvidenceIds: EVIDENCE,
      expectedState: "missing_rule",
      commissionAmount: null,
    }),
  );
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  console.error(
    JSON.stringify({
      status: "FAIL",
      stage,
      code: error instanceof Error ? error.message : "unknown_error",
      sqlState: typeof error?.code === "string" ? error.code : undefined,
    }),
  );
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
