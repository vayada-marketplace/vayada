/** VAY-2297: how long one Stripe request may wait. Several callers hold a database row lock
 * while Stripe answers, and the API login's idle-in-transaction limit will go to 60 s; without
 * a cap, Node waits up to about five minutes for a hung connection. */
export const STRIPE_REQUEST_TIMEOUT_MS = 30_000;
