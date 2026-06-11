import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import type {
  ProviderWebhookMode,
  ProviderWebhookPromotionInput,
  ProviderWebhookReceiptInput,
  ProviderWebhookReceiptLifecycleStatus,
  ProviderWebhookStore,
} from "./routes/providerWebhooks.js";

const fixedNow = new Date("2026-06-11T12:00:00.000Z");

describe("target provider webhook routes", () => {
  for (const provider of ["stripe", "xendit", "channex"] as const) {
    for (const mode of ["observe_only", "ack_only_with_receipt", "mutating"] as const) {
      it(`${provider} verifies signatures and dedupes replayed receipts in ${mode}`, async () => {
        const store = createMemoryProviderWebhookStore();
        const app = buildApp({
          providerWebhooks: {
            secrets: {
              stripe: "whsec_stripe_test",
              xendit: "xendit-secret",
              channex: "channex-secret",
            },
            modes: {
              [provider]: mode,
            },
            store,
            now: () => fixedNow,
          },
        });

        const first = await postProviderFixture(app, provider);
        const second = await postProviderFixture(app, provider);

        expect(first.statusCode).toBe(200);
        expect(second.statusCode).toBe(200);
        expect(store.receipts).toHaveLength(1);
        expect(store.idempotencyKeys).toContain(store.receipts[0]!.receiptKey);
        expect(store.receipts[0]!.lifecycleStatus).toBe(
          mode === "mutating" ? "promoted" : "observed",
        );

        if (mode === "observe_only") {
          expect(first.json()).toMatchObject({ status: "observed", mode });
          expect(second.json()).toMatchObject({ status: "duplicate_observed", mode });
          expect(store.domainEvents).toHaveLength(0);
          expect(store.jobs).toHaveLength(0);
        } else if (mode === "ack_only_with_receipt") {
          expect(first.json()).toMatchObject({
            status: "acknowledged",
            mode,
            replayRequired: true,
          });
          expect(second.json()).toMatchObject({
            status: "duplicate_acknowledged",
            mode,
            replayRequired: true,
          });
          expect(store.domainEvents).toHaveLength(0);
          expect(store.jobs).toHaveLength(0);
        } else {
          expect(first.json()).toMatchObject({ status: "promoted", mode });
          expect(second.json()).toMatchObject({
            status: "duplicate",
            mode,
            lifecycleStatus: "promoted",
          });
          expect(store.domainEvents).toHaveLength(1);
          expect(store.jobs).toHaveLength(1);
          expect(store.idempotencyKeys).toContain(store.domainEvents[0]!.domainEventKey);
          expect(store.idempotencyKeys).toContain(store.jobs[0]!.jobKey);
        }

        await app.close();
      });
    }

    it(`${provider} rejects invalid authentication before recording a receipt`, async () => {
      const store = createMemoryProviderWebhookStore();
      const app = buildApp({
        providerWebhooks: {
          secrets: {
            stripe: "whsec_stripe_test",
            xendit: "xendit-secret",
            channex: "channex-secret",
          },
          store,
          now: () => fixedNow,
        },
      });

      const response = await postProviderFixture(app, provider, { invalidAuth: true });

      expect(response.statusCode).toBe(provider === "channex" ? 401 : 400);
      expect(store.receipts).toHaveLength(0);
      expect(store.domainEvents).toHaveLength(0);
      expect(store.jobs).toHaveLength(0);
      await app.close();
    });
  }

  it("uses the cutover receipt-key scheme for each provider fixture", async () => {
    const store = createMemoryProviderWebhookStore();
    const app = buildApp({
      providerWebhooks: {
        secrets: {
          stripe: "whsec_stripe_test",
          xendit: "xendit-secret",
          channex: "channex-secret",
        },
        modes: {
          stripe: "observe_only",
          xendit: "observe_only",
          channex: "observe_only",
        },
        store,
        now: () => fixedNow,
      },
    });

    await postProviderFixture(app, "stripe");
    await postProviderFixture(app, "xendit");
    await postProviderFixture(app, "channex");

    expect(store.receipts.map((receipt) => receipt.receiptKey)).toEqual([
      "webhook:stripe:evt_stripe_pi_succeeded",
      "webhook:xendit:invoice:inv_xendit_paid:PAID",
      "webhook:channex:message:prop_channex_123:msg_channex_456",
    ]);
    await app.close();
  });

  it("uses actual Channex message payload ids for receipt and domain event keys", async () => {
    const store = createMemoryProviderWebhookStore();
    const app = buildApp({
      providerWebhooks: {
        secrets: { channex: "channex-secret" },
        modes: { channex: "mutating" },
        store,
        now: () => fixedNow,
      },
    });
    const payload = {
      event: "message",
      payload: {
        property_id: "prop_channex_123",
        id: "msg_actual_456",
        message_thread_id: "thread_actual_789",
        body: "Hello",
      },
    };

    const unconfiguredStripe = await postProviderFixture(app, "stripe");
    const unconfiguredXendit = await postProviderFixture(app, "xendit");
    expect(unconfiguredStripe.statusCode).toBe(503);
    expect(unconfiguredXendit.statusCode).toBe(503);
    expect(store.receipts).toHaveLength(0);
    expect(store.domainEvents).toHaveLength(0);
    expect(store.jobs).toHaveLength(0);

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/channex",
      headers: fixtureHeaders("channex", payload),
      payload: JSON.stringify(payload),
    });

    expect(response.statusCode).toBe(200);
    expect(store.receipts[0]?.receiptKey).toBe(
      "webhook:channex:message:prop_channex_123:msg_actual_456",
    );
    expect(store.domainEvents[0]?.domainEventKey).toBe(
      "channex.message.ingest:prop_channex_123:thread_actual_789:msg_actual_456:v1",
    );
    await app.close();
  });

  it("rejects duplicate receipt keys when the semantic payload changes", async () => {
    const store = createMemoryProviderWebhookStore();
    const app = buildApp({
      providerWebhooks: {
        secrets: { stripe: "whsec_stripe_test" },
        modes: { stripe: "observe_only" },
        store,
        now: () => fixedNow,
      },
    });
    const first = providerFixture("stripe").payload;
    const changed = {
      ...first,
      data: {
        object: {
          id: "pi_stripe_123",
          amount_received: 99000,
          status: "succeeded",
        },
      },
    };

    const firstResponse = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: fixtureHeaders("stripe", first),
      payload: JSON.stringify(first),
    });
    const changedResponse = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: fixtureHeaders("stripe", changed),
      payload: JSON.stringify(changed),
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(changedResponse.statusCode).toBe(409);
    expect(changedResponse.json()).toMatchObject({
      error: "provider_webhook_receipt_conflict",
      receiptKey: "webhook:stripe:evt_stripe_pi_succeeded",
    });
    expect(store.receipts).toHaveLength(1);
    expect(store.domainEvents).toHaveLength(0);
    expect(store.jobs).toHaveLength(0);
    await app.close();
  });

  it("promotes an observed receipt exactly once when mutating replay arrives", async () => {
    const store = createMemoryProviderWebhookStore();
    const observedApp = buildApp({
      providerWebhooks: {
        secrets: { stripe: "whsec_stripe_test" },
        modes: { stripe: "observe_only" },
        store,
        now: () => fixedNow,
      },
    });

    await postProviderFixture(observedApp, "stripe");
    await observedApp.close();

    const mutatingApp = buildApp({
      providerWebhooks: {
        secrets: { stripe: "whsec_stripe_test" },
        modes: { stripe: "mutating" },
        store,
        now: () => fixedNow,
      },
    });

    const firstReplay = await postProviderFixture(mutatingApp, "stripe");
    const secondReplay = await postProviderFixture(mutatingApp, "stripe");

    expect(firstReplay.json()).toMatchObject({ status: "promoted" });
    expect(secondReplay.json()).toMatchObject({ status: "duplicate" });
    expect(store.receipts).toHaveLength(1);
    expect(store.receipts[0]!.lifecycleStatus).toBe("promoted");
    expect(store.domainEvents).toHaveLength(1);
    expect(store.jobs).toHaveLength(1);
    await mutatingApp.close();
  });

  it("runs promotion for normalized duplicate receipts in mutating mode", async () => {
    const store = createMemoryProviderWebhookStore();
    const observedApp = buildApp({
      providerWebhooks: {
        secrets: { stripe: "whsec_stripe_test" },
        modes: { stripe: "observe_only" },
        store,
        now: () => fixedNow,
      },
    });

    await postProviderFixture(observedApp, "stripe");
    await observedApp.close();
    store.receipts[0]!.lifecycleStatus = "normalized";

    const mutatingApp = buildApp({
      providerWebhooks: {
        secrets: { stripe: "whsec_stripe_test" },
        modes: { stripe: "mutating" },
        store,
        now: () => fixedNow,
      },
    });

    const response = await postProviderFixture(mutatingApp, "stripe");

    expect(response.json()).toMatchObject({ status: "already_normalized" });
    expect(store.receipts).toHaveLength(1);
    expect(store.receipts[0]!.lifecycleStatus).toBe("normalized");
    expect(store.domainEvents).toHaveLength(1);
    expect(store.jobs).toHaveLength(1);
    await mutatingApp.close();
  });
});

type MemoryProviderWebhookStore = ProviderWebhookStore & {
  receipts: Array<
    ProviderWebhookReceiptInput & {
      receiptId: string;
      lifecycleStatus: ProviderWebhookReceiptLifecycleStatus;
    }
  >;
  domainEvents: Array<{ domainEventId: string; domainEventKey: string }>;
  jobs: Array<{ jobId: string; jobKey: string }>;
  idempotencyKeys: string[];
};

function createMemoryProviderWebhookStore(): MemoryProviderWebhookStore {
  const receipts: MemoryProviderWebhookStore["receipts"] = [];
  const domainEvents: MemoryProviderWebhookStore["domainEvents"] = [];
  const jobs: MemoryProviderWebhookStore["jobs"] = [];
  const idempotencyKeys: string[] = [];

  return {
    receipts,
    domainEvents,
    jobs,
    idempotencyKeys,
    async recordReceipt(input) {
      const existing = receipts.find((receipt) => receipt.receiptKey === input.receiptKey);
      if (existing) {
        if (existing.payloadHash !== input.payloadHash) {
          return {
            status: "conflict",
            receiptId: existing.receiptId,
            lifecycleStatus: existing.lifecycleStatus,
          };
        }
        idempotencyKeys.push(input.receiptKey);
        return {
          status: "duplicate",
          receiptId: existing.receiptId,
          lifecycleStatus: existing.lifecycleStatus,
        };
      }
      const receiptId = `receipt_${receipts.length + 1}`;
      receipts.push({ ...input, receiptId, lifecycleStatus: "observed" });
      idempotencyKeys.push(input.receiptKey);
      return { status: "inserted", receiptId, lifecycleStatus: "observed" };
    },
    async promoteReceipt(input: ProviderWebhookPromotionInput) {
      const receipt = receipts.find((candidate) => candidate.receiptId === input.receiptId);
      if (!receipt) throw new Error(`Unknown receipt ${input.receiptId}`);
      const existingEvent = domainEvents.find(
        (event) => event.domainEventKey === input.normalizedPreview.domainEventKey,
      );
      const existingJob = jobs.find((job) => job.jobKey === input.normalizedPreview.jobKey);
      const domainEventId = existingEvent?.domainEventId ?? `event_${domainEvents.length + 1}`;
      if (!existingEvent) {
        domainEvents.push({
          domainEventId,
          domainEventKey: input.normalizedPreview.domainEventKey,
        });
      }
      const jobId = existingJob?.jobId ?? `job_${jobs.length + 1}`;
      if (!existingJob) {
        jobs.push({ jobId, jobKey: input.normalizedPreview.jobKey });
      }

      if (receipt.lifecycleStatus !== "observed") {
        return {
          status: promotionStatusForReceipt(receipt.lifecycleStatus),
          receiptId: input.receiptId,
          domainEventId,
          jobIds: [jobId],
        };
      }

      idempotencyKeys.push(input.normalizedPreview.domainEventKey);
      idempotencyKeys.push(input.normalizedPreview.jobKey);
      receipt.lifecycleStatus = "promoted";
      return {
        status: "promoted",
        receiptId: input.receiptId,
        domainEventId,
        jobIds: [jobId],
      };
    },
  };
}

function promotionStatusForReceipt(
  status: ProviderWebhookReceiptLifecycleStatus,
): Awaited<ReturnType<ProviderWebhookStore["promoteReceipt"]>>["status"] {
  switch (status) {
    case "promoted":
      return "already_promoted";
    case "normalized":
      return "already_normalized";
    case "failed":
      return "failed";
    case "dead_lettered":
      return "dead_lettered";
    default:
      return "incompatible_terminal_state";
  }
}

async function postProviderFixture(
  app: ReturnType<typeof buildApp>,
  provider: "stripe" | "xendit" | "channex",
  options: { invalidAuth?: boolean } = {},
) {
  const fixture = providerFixture(provider);
  return app.inject({
    method: "POST",
    url: `/webhooks/${provider}`,
    headers: fixtureHeaders(provider, fixture.payload, options.invalidAuth),
    payload: JSON.stringify(fixture.payload),
  });
}

function providerFixture(provider: "stripe" | "xendit" | "channex"): {
  payload: Record<string, unknown>;
} {
  switch (provider) {
    case "stripe":
      return {
        payload: {
          id: "evt_stripe_pi_succeeded",
          type: "payment_intent.succeeded",
          data: {
            object: {
              id: "pi_stripe_123",
              amount_received: 42000,
              status: "succeeded",
            },
          },
        },
      };
    case "xendit":
      return {
        payload: {
          id: "inv_xendit_paid",
          external_id: "booking_123",
          status: "PAID",
          paid_amount: 42000,
        },
      };
    case "channex":
      return {
        payload: {
          event: "message",
          property_id: "prop_channex_123",
          payload: {
            property_id: "prop_channex_123",
            message_id: "msg_channex_456",
            thread_id: "thread_channex_789",
          },
        },
      };
  }
}

function fixtureHeaders(
  provider: "stripe" | "xendit" | "channex",
  payload: Record<string, unknown>,
  invalidAuth = false,
): Record<string, string> {
  switch (provider) {
    case "stripe": {
      const timestamp = Math.floor(fixedNow.getTime() / 1000);
      const secret = invalidAuth ? "wrong-secret" : "whsec_stripe_test";
      const signature = createHmac("sha256", secret)
        .update(`${timestamp}.${JSON.stringify(payload)}`)
        .digest("hex");
      return {
        "content-type": "application/json",
        "stripe-signature": `t=${timestamp},v1=${signature}`,
      };
    }
    case "xendit":
      return {
        "content-type": "application/json",
        "x-callback-token": invalidAuth ? "wrong-secret" : "xendit-secret",
      };
    case "channex":
      return {
        "content-type": "application/json",
        "x-vayada-webhook-token": invalidAuth ? "wrong-secret" : "channex-secret",
      };
  }
}
