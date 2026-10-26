// The pure entry loads Stripe.js only when loadStripe runs, i.e. when the card form mounts.
// The default entry adds the script as soon as this module is imported (VAY-2216).
import { loadStripe } from "@stripe/stripe-js/pure";

const stripeInstances = new Map<string, ReturnType<typeof loadStripe>>();

export default function stripeForAccount(stripeAccountId?: string | null) {
  const key = stripeAccountId || "platform";
  const existing = stripeInstances.get(key);
  if (existing) return existing;
  const stripe = loadStripe(
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || "",
    stripeAccountId ? { stripeAccount: stripeAccountId } : undefined,
  );
  stripeInstances.set(key, stripe);
  return stripe;
}
