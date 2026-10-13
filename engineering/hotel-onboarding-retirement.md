# Hotel onboarding retirement — VAY-1051

The prerequisite-to-adaptive handoff shipped in #1805. Next activation shipped
through platform #117; the presentation draft/resume fix shipped in #1876.
On September 10, 2026, deployed testing verified new hotel creation, automatic
adaptive entry, saved presentation data, and PMS Exit/Resume on an isolated hotel.
Existing hotel selection and add-hotel prerequisite entry were also verified.

This is evidence for the handoff, not acceptance of every adaptive step.

## Safe cleanup

The private `@vayada/product-onboarding` workspace has no app consumers of
`BenefitsStep`, `useSetupWizardState`, or `LastMinuteStep`. Their only references
are package exports and the old state hook's last-minute configuration import.
Remove these unused components, hook, and exports in small dependency-ordered
PRs. Keep the live room benefits editor and pricing controls.

## Fallback retired (VAY-2174)

`AdaptiveSetupStepFormDispatcher` now handles every step, including
`guest_experience`, `payments`, and `review`; room authoring has its own
controller. Production ran only the step-by-step setup, so VAY-2174 removed
the `HOTEL_SETUP_ADAPTIVE_SHELL_ENABLED` switch and deleted the flag-disabled
setup plan: the wizard's task-list screen, `SetupTaskFormRouter`, and its
Marketplace, rooms, guest-policy, billing, payment, and publication forms.
`GET /api/hotel-setup/status` still returns `setupPlan`: every app's status
validator and the hotel-basics gate read it, so shrinking it is a separate,
two-release follow-up.

Preserve `SharedFirstRunPropertySetupWizard` creation/selection and hotel details,
plus prepared-import suggestions, source idempotency keys, and unsaved adjacent
edits. Explicit Add must continue to start a blank draft with a new creation key.
Keep invite and product return parameters intact. Prepared-import rollout
acceptance remains owned by its separate investigation; Airbnb import is outside
this cleanup.

For each remaining replacement step, verify first entry, canonical save,
incomplete draft Exit/Resume, revisiting a completed step, source-conflict
recovery, and return to the originating product. Do not remove readiness,
publication, entitlement, revision, or ownership guards during cleanup.
