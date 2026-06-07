import { describe, expect, it } from "vitest";

import {
  CHANNEX_ARI_PUSH_TRIGGERS,
  CHANNEX_GUEST_ALERT_KINDS,
  CHANNEX_INBOUND_REVISION_EVENTS,
  CHANNEX_JOB_CONTRACT_VERSION,
  CHANNEX_JOB_DEAD_LETTER_REASONS,
  CHANNEX_JOB_TYPES,
  buildAriBookingPushIdempotencyKey,
  buildAriRoomBlockPushIdempotencyKey,
  buildAriRoomTypePushIdempotencyKey,
  buildGuestBookingAlertIdempotencyKey,
  buildInboundRevisionIdempotencyKey,
  buildOtaBookingImportedNotificationIdempotencyKey,
  buildPayoutBookingSettledIdempotencyKey,
  buildSideEffectAuditIdempotencyKey,
  type ChannexAriBookingPushJob,
  type ChannexAriRoomBlockPushJob,
  type ChannexAriRoomTypePushJob,
  type ChannexGuestBookingAlertJob,
  type ChannexInboundRevisionJob,
  type ChannexJob,
  type ChannexJobDeadLetterEnvelope,
  type ChannexJobQueue,
  type ChannexNotificationSettingsReadModel,
  type ChannexNotificationSettingsReadPort,
  type ChannexOtaBookingImportedNotificationJob,
  type ChannexPayoutBookingSettledJob,
  type ChannexSideEffectAuditJob,
} from "./index.js";

// ── Shared audit fixture ──────────────────────────────────────────────────────

const sharedAudit = {
  contractVersion: CHANNEX_JOB_CONTRACT_VERSION,
  idempotencyKey: "shared-idem-key",
  propertyId: "prop_1",
  organizationId: "org_1",
  correlationId: "corr_1",
  scheduledAt: "2026-06-07T10:00:00.000Z",
  attemptNumber: 1,
  owner: "pms" as const,
};

// ── Contract version ──────────────────────────────────────────────────────────

describe("@vayada/domain-pms-channex", () => {
  it("exports the job contract version", () => {
    expect(CHANNEX_JOB_CONTRACT_VERSION).toBe("pms-channex-jobs.v1");
  });

  it("enumerates all expected job types", () => {
    expect(CHANNEX_JOB_TYPES).toContain("channex.inbound.revision.process");
    expect(CHANNEX_JOB_TYPES).toContain("channex.ari.room_type.push");
    expect(CHANNEX_JOB_TYPES).toContain("channex.ari.booking.push");
    expect(CHANNEX_JOB_TYPES).toContain("channex.ari.room_block.push");
    expect(CHANNEX_JOB_TYPES).toContain("channex.notification.ota_booking_imported");
    expect(CHANNEX_JOB_TYPES).toContain("channex.notification.guest_booking_alert");
    expect(CHANNEX_JOB_TYPES).toContain("channex.payout.booking_settled");
    expect(CHANNEX_JOB_TYPES).toContain("channex.audit.side_effect_recorded");
  });

  it("enumerates inbound revision events", () => {
    expect(CHANNEX_INBOUND_REVISION_EVENTS).toContain("booking.created");
    expect(CHANNEX_INBOUND_REVISION_EVENTS).toContain("booking.modified");
    expect(CHANNEX_INBOUND_REVISION_EVENTS).toContain("booking.cancelled");
  });

  it("enumerates ARI push triggers including all room-block lifecycle events", () => {
    // Room-block coverage required by acceptance criteria
    expect(CHANNEX_ARI_PUSH_TRIGGERS).toContain("room_block_created");
    expect(CHANNEX_ARI_PUSH_TRIGGERS).toContain("room_block_updated");
    expect(CHANNEX_ARI_PUSH_TRIGGERS).toContain("room_block_deleted");
  });

  it("enumerates dead-letter reasons", () => {
    expect(CHANNEX_JOB_DEAD_LETTER_REASONS).toContain("max_retries_exceeded");
    expect(CHANNEX_JOB_DEAD_LETTER_REASONS).toContain("mapping_missing");
    expect(CHANNEX_JOB_DEAD_LETTER_REASONS).toContain("notification_settings_unavailable");
  });

  it("enumerates guest alert kinds", () => {
    expect(CHANNEX_GUEST_ALERT_KINDS).toContain("booking_confirmed");
    expect(CHANNEX_GUEST_ALERT_KINDS).toContain("booking_cancelled");
    expect(CHANNEX_GUEST_ALERT_KINDS).toContain("change_request_received");
  });

  // ── Idempotency key builders ────────────────────────────────────────────────

  describe("idempotency key builders", () => {
    it("builds stable inbound revision keys", () => {
      const key = buildInboundRevisionIdempotencyKey({
        propertyId: "prop_1",
        channexBookingId: "chx_abc",
        revisionEvent: "booking.created",
        revisionSequence: "2026-06-07T10:00:00.000Z",
      });
      expect(key).toBe(
        "channex.inbound:prop_1:chx_abc:booking.created:2026-06-07T10:00:00.000Z:v1",
      );
      // Same inputs produce the same key (deterministic)
      expect(
        buildInboundRevisionIdempotencyKey({
          propertyId: "prop_1",
          channexBookingId: "chx_abc",
          revisionEvent: "booking.created",
          revisionSequence: "2026-06-07T10:00:00.000Z",
        }),
      ).toBe(key);
    });

    it("produces distinct keys for repeated booking.modified events via revisionSequence", () => {
      const key1 = buildInboundRevisionIdempotencyKey({
        propertyId: "prop_1",
        channexBookingId: "chx_abc",
        revisionEvent: "booking.modified",
        revisionSequence: "2026-06-07T10:00:00.000Z",
      });
      const key2 = buildInboundRevisionIdempotencyKey({
        propertyId: "prop_1",
        channexBookingId: "chx_abc",
        revisionEvent: "booking.modified",
        revisionSequence: "2026-06-07T10:05:00.000Z",
      });
      expect(key1).not.toBe(key2);
    });

    it("builds stable ARI room-type push keys", () => {
      const key = buildAriRoomTypePushIdempotencyKey({
        propertyId: "prop_1",
        roomTypeId: "rt_1",
        trigger: "room_block_created",
        triggerRefId: "rb_1",
      });
      expect(key).toBe("channex.ari.room_type:prop_1:rt_1:room_block_created:rb_1:v1");
    });

    it("builds stable ARI booking push keys", () => {
      const key = buildAriBookingPushIdempotencyKey({
        bookingId: "bk_1",
        trigger: "admin_booking_cancelled",
      });
      expect(key).toBe("channex.ari.booking:bk_1:admin_booking_cancelled:v1");
    });

    it("builds stable ARI room-block push keys", () => {
      const key = buildAriRoomBlockPushIdempotencyKey({
        roomBlockId: "rb_1",
        trigger: "room_block_deleted",
        occurredAt: "2026-06-07T10:00:00.000Z",
      });
      expect(key).toBe(
        "channex.ari.room_block:rb_1:room_block_deleted:2026-06-07T10:00:00.000Z:v1",
      );
    });

    it("produces distinct keys for repeated room_block_updated events via occurredAt", () => {
      const key1 = buildAriRoomBlockPushIdempotencyKey({
        roomBlockId: "rb_1",
        trigger: "room_block_updated",
        occurredAt: "2026-06-07T10:00:00.000Z",
      });
      const key2 = buildAriRoomBlockPushIdempotencyKey({
        roomBlockId: "rb_1",
        trigger: "room_block_updated",
        occurredAt: "2026-06-07T10:05:00.000Z",
      });
      expect(key1).not.toBe(key2);
    });

    it("builds stable OTA booking imported notification keys", () => {
      const key = buildOtaBookingImportedNotificationIdempotencyKey({
        propertyId: "prop_1",
        bookingId: "bk_1",
        revisionEvent: "booking.modified",
      });
      expect(key).toBe("channex.notification.ota_imported:prop_1:bk_1:booking.modified:v1");
    });

    it("builds stable guest booking alert keys", () => {
      const key = buildGuestBookingAlertIdempotencyKey({
        bookingId: "bk_1",
        alertKind: "booking_cancelled",
      });
      expect(key).toBe("channex.notification.guest_alert:bk_1:booking_cancelled:v1");
    });

    it("builds stable payout booking settled keys", () => {
      const key = buildPayoutBookingSettledIdempotencyKey({ bookingId: "bk_1" });
      expect(key).toBe("channex.payout.booking_settled:bk_1:v1");
    });

    it("builds stable side-effect audit keys", () => {
      const key = buildSideEffectAuditIdempotencyKey({
        correlationId: "corr_1",
        jobType: "channex.ari.room_type.push",
      });
      expect(key).toBe("channex.audit.side_effect:corr_1:channex.ari.room_type.push:v1");
    });
  });

  // ── Job type contracts ──────────────────────────────────────────────────────

  describe("job type contracts", () => {
    it("accepts a well-formed inbound revision job", () => {
      const job: ChannexInboundRevisionJob = {
        jobType: "channex.inbound.revision.process",
        jobId: "job_inbound_1",
        idempotencyKey: buildInboundRevisionIdempotencyKey({
          propertyId: "prop_1",
          channexBookingId: "chx_abc",
          revisionEvent: "booking.created",
          revisionSequence: "2026-06-07T10:00:00.000Z",
        }),
        audit: {
          ...sharedAudit,
          jobId: "job_inbound_1",
          jobType: "channex.inbound.revision.process",
        },
        retryPolicy: "exponential_backoff",
        maxAttempts: 5,
        payload: {
          channexBookingId: "chx_abc",
          propertyId: "prop_1",
          organizationId: "org_1",
          connectionId: "conn_1",
          channexPropertyId: "chx_prop_1",
          revisionEvent: "booking.created",
          revisionSequence: "2026-06-07T10:00:00.000Z",
          rawRevision: { id: "chx_abc", rooms: [{ room_type_id: "rt_1" }] },
          downstreamJobs: {
            ariPush: true,
            notification: true,
            audit: true,
          },
        },
      };
      expect(job.jobType).toBe("channex.inbound.revision.process");
      expect(job.payload.downstreamJobs.ariPush).toBe(true);
    });

    it("accepts a well-formed ARI room-type push job", () => {
      const job: ChannexAriRoomTypePushJob = {
        jobType: "channex.ari.room_type.push",
        jobId: "job_ari_1",
        idempotencyKey: buildAriRoomTypePushIdempotencyKey({
          propertyId: "prop_1",
          roomTypeId: "rt_1",
          trigger: "room_block_created",
          triggerRefId: "rb_1",
        }),
        audit: {
          ...sharedAudit,
          jobId: "job_ari_1",
          jobType: "channex.ari.room_type.push",
        },
        retryPolicy: "exponential_backoff",
        maxAttempts: 5,
        payload: {
          propertyId: "prop_1",
          organizationId: "org_1",
          connectionId: "conn_1",
          channexPropertyId: "chx_prop_1",
          roomTypeId: "rt_1",
          channexRoomTypeId: "chx_rt_1",
          trigger: "room_block_created",
          triggerRefId: "rb_1",
          dateRange: { from: "2026-09-01", to: "2026-09-30" },
          includeAvailability: true,
          includeRestrictions: true,
        },
      };
      expect(job.payload.trigger).toBe("room_block_created");
    });

    it("accepts a well-formed ARI booking push job", () => {
      const job: ChannexAriBookingPushJob = {
        jobType: "channex.ari.booking.push",
        jobId: "job_ari_bk_1",
        idempotencyKey: buildAriBookingPushIdempotencyKey({
          bookingId: "bk_1",
          trigger: "guest_change_approved",
        }),
        audit: {
          ...sharedAudit,
          jobId: "job_ari_bk_1",
          jobType: "channex.ari.booking.push",
        },
        retryPolicy: "exponential_backoff",
        maxAttempts: 5,
        payload: {
          propertyId: "prop_1",
          organizationId: "org_1",
          connectionId: "conn_1",
          channexPropertyId: "chx_prop_1",
          bookingId: "bk_1",
          trigger: "guest_change_approved",
          affectedRoomTypeIds: ["rt_1"],
        },
      };
      expect(job.payload.trigger).toBe("guest_change_approved");
      expect(job.payload.connectionId).toBe("conn_1");
      expect(job.payload.channexPropertyId).toBe("chx_prop_1");
    });

    it("accepts a well-formed ARI room-block push job covering all lifecycle triggers", () => {
      const triggers = ["room_block_created", "room_block_updated", "room_block_deleted"] as const;

      for (const trigger of triggers) {
        const occurredAt = "2026-10-01T08:00:00.000Z";
        const job: ChannexAriRoomBlockPushJob = {
          jobType: "channex.ari.room_block.push",
          jobId: `job_rb_${trigger}`,
          idempotencyKey: buildAriRoomBlockPushIdempotencyKey({
            roomBlockId: "rb_1",
            trigger,
            occurredAt,
          }),
          audit: {
            ...sharedAudit,
            jobId: `job_rb_${trigger}`,
            jobType: "channex.ari.room_block.push",
          },
          retryPolicy: "exponential_backoff",
          maxAttempts: 5,
          payload: {
            propertyId: "prop_1",
            organizationId: "org_1",
            connectionId: "conn_1",
            channexPropertyId: "chx_prop_1",
            roomBlockId: "rb_1",
            roomTypeId: "rt_1",
            trigger,
            dateRange: { from: "2026-10-01", to: "2026-10-07" },
            occurredAt,
          },
        };
        expect(job.payload.trigger).toBe(trigger);
        expect(job.payload.connectionId).toBe("conn_1");
        expect(job.payload.channexPropertyId).toBe("chx_prop_1");
        expect(job.payload.occurredAt).toBe(occurredAt);
      }
    });

    it("accepts a well-formed OTA booking imported notification job with notification preferences", () => {
      const job: ChannexOtaBookingImportedNotificationJob = {
        jobType: "channex.notification.ota_booking_imported",
        jobId: "job_notif_1",
        idempotencyKey: buildOtaBookingImportedNotificationIdempotencyKey({
          propertyId: "prop_1",
          bookingId: "bk_1",
          revisionEvent: "booking.created",
        }),
        audit: {
          ...sharedAudit,
          jobId: "job_notif_1",
          jobType: "channex.notification.ota_booking_imported",
          owner: "notification",
        },
        retryPolicy: "fixed_interval",
        maxAttempts: 3,
        payload: {
          propertyId: "prop_1",
          organizationId: "org_1",
          bookingId: "bk_1",
          channexBookingId: "chx_abc",
          revisionEvent: "booking.created",
          trigger: "ota_booking_imported",
          recipientEmail: "host@hotel.example",
          notificationPreferences: {
            emailNotificationsEnabled: true,
            otaBookingAlertsEnabled: true,
          },
        },
      };
      // Notification preferences are part of the payload (not a DB read inside ingestion)
      expect(job.payload.notificationPreferences.emailNotificationsEnabled).toBe(true);
      expect(job.payload.notificationPreferences.otaBookingAlertsEnabled).toBe(true);
      expect(job.payload.trigger).toBe("ota_booking_imported");
    });

    it("accepts a well-formed guest booking alert job", () => {
      const job: ChannexGuestBookingAlertJob = {
        jobType: "channex.notification.guest_booking_alert",
        jobId: "job_guest_alert_1",
        idempotencyKey: buildGuestBookingAlertIdempotencyKey({
          bookingId: "bk_1",
          alertKind: "booking_confirmed",
        }),
        audit: {
          ...sharedAudit,
          jobId: "job_guest_alert_1",
          jobType: "channex.notification.guest_booking_alert",
          owner: "notification",
        },
        retryPolicy: "fixed_interval",
        maxAttempts: 3,
        payload: {
          propertyId: "prop_1",
          organizationId: "org_1",
          bookingId: "bk_1",
          bookingReference: "VAY-2026-0042",
          alertKind: "booking_confirmed",
          recipientEmail: "guest@example.com",
          locale: "en",
        },
      };
      expect(job.payload.alertKind).toBe("booking_confirmed");
    });

    it("accepts a well-formed payout booking settled job", () => {
      const job: ChannexPayoutBookingSettledJob = {
        jobType: "channex.payout.booking_settled",
        jobId: "job_payout_1",
        idempotencyKey: buildPayoutBookingSettledIdempotencyKey({ bookingId: "bk_1" }),
        audit: {
          ...sharedAudit,
          jobId: "job_payout_1",
          jobType: "channex.payout.booking_settled",
          owner: "finance",
        },
        retryPolicy: "exponential_backoff",
        maxAttempts: 5,
        payload: {
          propertyId: "prop_1",
          organizationId: "org_1",
          bookingId: "bk_1",
          bookingReference: "VAY-2026-0042",
          settledAt: "2026-09-15T12:00:00.000Z",
        },
      };
      expect(job.payload.bookingId).toBe("bk_1");
    });

    it("accepts a well-formed side-effect audit job with maxAttempts=1", () => {
      const job: ChannexSideEffectAuditJob = {
        jobType: "channex.audit.side_effect_recorded",
        jobId: "job_audit_1",
        idempotencyKey: buildSideEffectAuditIdempotencyKey({
          correlationId: "corr_1",
          jobType: "channex.ari.room_type.push",
        }),
        audit: {
          ...sharedAudit,
          jobId: "job_audit_1",
          jobType: "channex.audit.side_effect_recorded",
        },
        retryPolicy: "no_retry",
        maxAttempts: 1,
        payload: {
          propertyId: "prop_1",
          organizationId: "org_1",
          auditedJobId: "job_ari_1",
          auditedJobType: "channex.ari.room_type.push",
          outcome: "completed",
          occurredAt: "2026-06-07T10:01:00.000Z",
        },
      };
      // Audit jobs must not retry (fire-and-forget in the audit lane)
      expect(job.maxAttempts).toBe(1);
      expect(job.retryPolicy).toBe("no_retry");
    });
  });

  // ── ChannexJobQueue port ─────────────────────────────────────────────────────

  describe("ChannexJobQueue port", () => {
    it("allows downstream code to implement the job queue interface", async () => {
      const enqueued: ChannexJob[] = [];

      const queue: ChannexJobQueue = {
        async enqueue(job) {
          enqueued.push(job);
          return { jobId: job.jobId, idempotencyKey: job.idempotencyKey };
        },
        async enqueueMany(jobs) {
          enqueued.push(...jobs);
          return jobs.map((j) => ({ jobId: j.jobId, idempotencyKey: j.idempotencyKey }));
        },
      };

      const job: ChannexAriRoomBlockPushJob = {
        jobType: "channex.ari.room_block.push",
        jobId: "job_rb_2",
        idempotencyKey: buildAriRoomBlockPushIdempotencyKey({
          roomBlockId: "rb_2",
          trigger: "room_block_updated",
          occurredAt: "2026-10-01T08:00:00.000Z",
        }),
        audit: {
          ...sharedAudit,
          jobId: "job_rb_2",
          jobType: "channex.ari.room_block.push",
        },
        retryPolicy: "exponential_backoff",
        maxAttempts: 5,
        payload: {
          propertyId: "prop_1",
          organizationId: "org_1",
          connectionId: "conn_1",
          channexPropertyId: "chx_prop_1",
          roomBlockId: "rb_2",
          roomTypeId: "rt_1",
          trigger: "room_block_updated",
          dateRange: { from: "2026-10-01", to: "2026-10-07" },
          occurredAt: "2026-10-01T08:00:00.000Z",
        },
      };

      const result = await queue.enqueue(job);
      expect(result.jobId).toBe("job_rb_2");
      expect(enqueued).toHaveLength(1);
    });
  });

  // ── Dead-letter envelope ──────────────────────────────────────────────────────

  describe("ChannexJobDeadLetterEnvelope", () => {
    it("accepts a valid dead-letter envelope with all required fields", () => {
      const envelope: ChannexJobDeadLetterEnvelope = {
        contractVersion: CHANNEX_JOB_CONTRACT_VERSION,
        jobId: "job_ari_1",
        jobType: "channex.ari.room_type.push",
        idempotencyKey: "channex.ari.room_type:prop_1:rt_1:room_block_created:rb_1:v1",
        propertyId: "prop_1",
        organizationId: "org_1",
        correlationId: "corr_1",
        deadLetterReason: "max_retries_exceeded",
        lastError: "Provider returned 503 after 5 attempts",
        failedAt: "2026-06-07T10:30:00.000Z",
        attemptCount: 5,
        originalPayload: {
          propertyId: "prop_1",
          roomTypeId: "rt_1",
          trigger: "room_block_created",
        },
      };
      expect(envelope.contractVersion).toBe("pms-channex-jobs.v1");
      expect(envelope.deadLetterReason).toBe("max_retries_exceeded");
      expect(envelope.attemptCount).toBe(5);
      expect(envelope.jobType).toBe("channex.ari.room_type.push");
    });
  });

  // ── Notification settings read model ─────────────────────────────────────────

  describe("ChannexNotificationSettingsReadPort", () => {
    it("allows consuming notification settings without direct booking_db access", async () => {
      const fakeSettings: ChannexNotificationSettingsReadModel = {
        propertyId: "prop_1",
        organizationId: "org_1",
        emailNotificationsEnabled: true,
        otaBookingAlertsEnabled: true,
        contactEmail: "host@hotel.example",
        settingsSnapshotAt: "2026-06-07T09:00:00.000Z",
      };

      const port: ChannexNotificationSettingsReadPort = {
        async getNotificationSettings({ propertyId }) {
          if (propertyId === "prop_1") return fakeSettings;
          return null;
        },
      };

      const result = await port.getNotificationSettings({ propertyId: "prop_1" });
      expect(result?.emailNotificationsEnabled).toBe(true);
      expect(result?.contactEmail).toBe("host@hotel.example");

      const missing = await port.getNotificationSettings({ propertyId: "unknown" });
      expect(missing).toBeNull();
    });
  });
});
