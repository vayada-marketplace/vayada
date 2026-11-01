import type { FastifyInstance } from "fastify";
import type { VayadaPaymentWebhookResult } from "../domains/vayadaPaymentWebhookEvents.js";
import { verifyStripeSignature } from "./providerWebhooks.js";

/** vayada Payment's own Stripe account sends its events here (VAY-2442), signed with its own
 * secret (VAYADA_PAYMENT_STRIPE_WEBHOOK_SECRET). Registered only with that secret. Test mode only:
 * a live event is acknowledged and left alone until a live setup exists. */
export async function registerVayadaPaymentWebhookRoutes(
  app: FastifyInstance,
  options: {
    secret: string;
    handle(event: Record<string, unknown>): Promise<VayadaPaymentWebhookResult>;
    now?: () => Date;
  },
) {
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    done(null, typeof body === "string" ? body : body.toString());
  });
  app.post<{ Body: string }>("/webhooks/stripe/vayada-payment", async (request, reply) => {
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
    if (event.livemode !== false) {
      request.log.warn(
        { eventId: event.id, type: event.type },
        "vayada Payment: live event ignored",
      );
      return { received: true, handled: false };
    }
    return { received: true, handled: (await options.handle(event)) === "handled" };
  });
}
