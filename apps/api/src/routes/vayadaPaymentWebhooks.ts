import type { FastifyInstance } from "fastify";
import type { VayadaPaymentWebhookResult } from "../domains/vayadaPaymentWebhookEvents.js";
import { verifyStripeSignature } from "./providerWebhooks.js";

/** vayada Payment's own Stripe account sends its events here (VAY-2442), one endpoint per mode,
 * each signed with its own secret: test mode at /webhooks/stripe/vayada-payment
 * (VAYADA_PAYMENT_STRIPE_WEBHOOK_SECRET), live mode at /webhooks/stripe/vayada-payment-live
 * (VAYADA_PAYMENT_STRIPE_LIVE_WEBHOOK_SECRET). Each is registered only with its secret, and an
 * event of the other mode is acknowledged and left alone. */
export async function registerVayadaPaymentWebhookRoutes(
  app: FastifyInstance,
  options: {
    secret: string;
    /** The live-mode endpoint; the test-mode one when left out. */
    livemode?: boolean;
    handle(event: Record<string, unknown>): Promise<VayadaPaymentWebhookResult>;
    now?: () => Date;
  },
) {
  const livemode = options.livemode === true;
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    done(null, typeof body === "string" ? body : body.toString());
  });
  const path = livemode
    ? "/webhooks/stripe/vayada-payment-live"
    : "/webhooks/stripe/vayada-payment";
  app.post<{ Body: string }>(path, async (request, reply) => {
    const signature = request.headers["stripe-signature"];
    if (
      typeof signature !== "string" ||
      !verifyStripeSignature({
        payload: request.body,
        signatureHeader: signature,
        secret: options.secret,
        now: options.now,
      })
    )
      return reply.code(400).send({ error: "invalid_stripe_signature" });
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(request.body);
    } catch {
      return reply.code(400).send({ error: "invalid_stripe_payload" });
    }
    if (!event || typeof event !== "object" || typeof event.type !== "string")
      return reply.code(400).send({ error: "invalid_stripe_payload" });
    // Connected-account events belong to /webhooks/stripe/connect, never to Vayada's own account.
    if (event.account !== undefined && event.account !== null)
      return reply.code(400).send({ error: "unexpected_connected_account" });
    if (event.livemode !== livemode) {
      request.log.warn(
        { eventId: event.id, type: event.type, livemode: event.livemode },
        livemode
          ? "vayada Payment: test event on the live endpoint ignored"
          : "vayada Payment: live event ignored",
      );
      return { received: true, handled: false };
    }
    return { received: true, handled: (await options.handle(event)) === "handled" };
  });
}
