// Flamur's never list (decision of 2026-11-20): no AI action, for any role, on any surface.
//
// This file is the list on its own on purpose. The registry checks it directly (not through the
// classification), an exact classification entry can not override it, and the classification test
// keeps a floor on its size: taking a route off this list needs Flamur's decision (plan decision
// log) and shows up as a change to this file and to that floor.

export type NeverArea =
  | "bank_accounts_and_payouts"
  | "team_members_and_permissions"
  | "property_deletion"
  | "login_and_security"
  | "legal_terms"
  | "billing_and_plan"
  | "bulk_exports"
  | "privacy_export_and_delete"
  | "guest_id_documents"
  | "ai_connections"
  | "partner_app_approvals"
  | "platform_and_staff";

type NeverEntry = { area: NeverArea; note?: string };

/** Whole never areas by path (every route under them, also routes added later). */
export const NEVER_RULES: readonly { match: RegExp; area: NeverArea }[] = Object.freeze([
  { match: /^(?!OPTIONS)[A-Z]+ \/auth\//, area: "login_and_security" },
  {
    match: /^(?!OPTIONS)[A-Z]+ \/api\/(platform|finance\/platform|identity\/admin)\/(?!health$)/,
    area: "platform_and_staff",
  },
  { match: /^(?!OPTIONS)[A-Z]+ \/api\/identity\/staff\//, area: "team_members_and_permissions" },
  { match: /^(?!OPTIONS)[A-Z]+ \/api\/identity\/gdpr\//, area: "privacy_export_and_delete" },
]);

/** Never routes outside those areas, one entry each. */
export const NEVER_ROUTES: Readonly<Record<string, NeverEntry>> = Object.freeze({
  "GET /api/booking/partner-authorizations": { area: "partner_app_approvals" },
  "POST /api/booking/partner-authorizations": { area: "partner_app_approvals" },
  "DELETE /api/booking/properties/:propertyId/partner-connections/:connectionId": {
    area: "partner_app_approvals",
    note: "disconnecting a partner app",
  },
  "GET /api/finance/properties/:propertyId/bank-transfer-destination": {
    area: "bank_accounts_and_payouts",
  },
  "PUT /api/finance/properties/:propertyId/bank-transfer-destination": {
    area: "bank_accounts_and_payouts",
  },
  "GET /api/finance/properties/:propertyId/billing": { area: "billing_and_plan" },
  "PATCH /api/finance/properties/:propertyId/billing-details": { area: "billing_and_plan" },
  "POST /api/finance/properties/:propertyId/customer-portal": { area: "billing_and_plan" },
  "POST /api/finance/properties/:propertyId/financials/exports": { area: "bulk_exports" },
  "GET /api/finance/properties/:propertyId/financials/exports/:exportId": { area: "bulk_exports" },
  "POST /api/finance/properties/:propertyId/financials/exports/auto": { area: "bulk_exports" },
  "POST /api/finance/properties/:propertyId/fixed-plan/card": { area: "billing_and_plan" },
  "POST /api/finance/properties/:propertyId/fixed-plan/checkout": { area: "billing_and_plan" },
  "POST /api/finance/properties/:propertyId/fixed-plan/invoice": { area: "billing_and_plan" },
  "PATCH /api/finance/properties/:propertyId/payment-method": { area: "billing_and_plan" },
  "GET /api/finance/properties/:propertyId/payout-destination": {
    area: "bank_accounts_and_payouts",
  },
  "PUT /api/finance/properties/:propertyId/payout-destination": {
    area: "bank_accounts_and_payouts",
  },
  "GET /api/finance/properties/:propertyId/payouts": { area: "bank_accounts_and_payouts" },
  "POST /api/finance/properties/:propertyId/payouts/:payoutId/dispatch": {
    area: "bank_accounts_and_payouts",
  },
  "GET /api/finance/properties/:propertyId/plan-status": { area: "billing_and_plan" },
  "POST /api/finance/properties/:propertyId/provider-accounts/:providerAccountId/onboarding-link": {
    area: "bank_accounts_and_payouts",
  },
  "POST /api/finance/properties/:propertyId/provider-accounts/stripe": {
    area: "bank_accounts_and_payouts",
  },
  "POST /api/finance/properties/:propertyId/provider-accounts/stripe/dashboard-link": {
    area: "bank_accounts_and_payouts",
  },
  "POST /api/finance/properties/:propertyId/provider-accounts/stripe/reconcile": {
    area: "bank_accounts_and_payouts",
  },
  "POST /api/finance/properties/:propertyId/provider-accounts/xendit/bank-validation": {
    area: "bank_accounts_and_payouts",
  },
  "GET /api/finance/properties/:propertyId/reconciliation/payments": {
    area: "bank_accounts_and_payouts",
  },
  "GET /api/finance/properties/:propertyId/reconciliation/payouts": {
    area: "bank_accounts_and_payouts",
  },
  "GET /api/finance/properties/:propertyId/reconciliation/provider-accounts": {
    area: "bank_accounts_and_payouts",
  },
  "POST /api/finance/properties/:propertyId/reconciliation/xendit-payouts": {
    area: "bank_accounts_and_payouts",
  },
  "POST /api/finance/properties/:propertyId/select-commission": { area: "billing_and_plan" },
  "POST /api/finance/properties/:propertyId/switch-to-commission": { area: "billing_and_plan" },
  "POST /api/finance/properties/:propertyId/switch-to-commission-now": { area: "billing_and_plan" },
  "GET /api/hotel-account/agreements": { area: "legal_terms" },
  "POST /api/hotel-account/agreements/accept": { area: "legal_terms" },
  "POST /api/hotel-setup/hotel-account-invites/lookup": {
    area: "team_members_and_permissions",
    note: "joining an account",
  },
  "POST /api/hotel-setup/hotel-account-invites/redeem": {
    area: "team_members_and_permissions",
    note: "joining an account",
  },
  "POST /api/hotel-setup/properties/:propertyId/delete": { area: "property_deletion" },
  "GET /api/hotel-setup/properties/:propertyId/deletion-check": { area: "property_deletion" },
  "POST /api/hotel-setup/properties/:propertyId/first-run": {
    area: "billing_and_plan",
    note: "sets the Commission plan",
  },
  "GET /api/identity/consent/cookies": { area: "legal_terms", note: "cookie and privacy consent" },
  "POST /api/identity/consent/cookies": { area: "legal_terms", note: "cookie and privacy consent" },
  "GET /api/identity/consent/history": { area: "legal_terms", note: "cookie and privacy consent" },
  "GET /api/identity/consent/me": { area: "legal_terms", note: "cookie and privacy consent" },
  "PUT /api/identity/consent/me": { area: "legal_terms", note: "cookie and privacy consent" },
  "PUT /api/pms/properties/:propertyId/mandatory-charge-confirmation": {
    area: "legal_terms",
    note: "a permanent charges statement",
  },
  "GET /api/pms/properties/:propertyId/reservations/:guestBookingId/guest-registrations": {
    area: "guest_id_documents",
  },
  "PUT /api/pms/properties/:propertyId/reservations/:guestBookingId/guest-registrations/:guestId": {
    area: "guest_id_documents",
  },
  "GET /auth/admin-transfer/callback": { area: "team_members_and_permissions" },
  "POST /auth/admin-transfer/complete": { area: "team_members_and_permissions" },
  "POST /auth/admin-transfer/start": { area: "team_members_and_permissions" },
  "POST /auth/invitations/accept": { area: "team_members_and_permissions" },
  "POST /auth/invitations/preview": { area: "team_members_and_permissions" },
});

/** The never area of a route, or undefined when it is not on the never list. */
export function neverArea(route: string): NeverEntry | undefined {
  const exact = NEVER_ROUTES[route];
  if (exact) return exact;
  const rule = NEVER_RULES.find((candidate) => candidate.match.test(route));
  return rule ? { area: rule.area } : undefined;
}
