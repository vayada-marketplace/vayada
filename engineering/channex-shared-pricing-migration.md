# Migrating an existing property to shared Channex pricing

VAY-1550. This is a manual acceptance runbook, not an automatic migration.
New connections use the strategy in `generic-channex-channel-provisioning.md`.
Existing properties must retain their rates and Vayada markups until a separately
authorized property-specific migration passes the checks below.

1. Name the internal property ID, bound Channex property ID, provider channel IDs,
   and authorized operator. Verify the active binding claim. Inventory active and
   disabled room/rate mappings, Vayada percentages, native modifier sequences,
   currency, meal plans, occupancy products and channel listing mappings.
   Store sanitized evidence; exclude credentials and provider settings wholesale.
2. Capture the current final outgoing price, availability and restrictions for
   representative seasonal and date overrides, each occupancy product and meal,
   minimum/maximum stays, closed arrival/departure and same-day cutoff cases.
   Include rounding boundaries, percentage decreases and compound/amount modifiers.
   A base-rate read or successful API response alone is not final-price evidence.
3. Prepare candidate shared rates without deleting or remapping the old ones.
   Seed canonical date-specific prices and restrictions first. Decide exactly which
   layer owns each adjustment. Set the candidate native modifier so it produces
   the existing final price; never copy a Vayada percentage onto an already adjusted
   rate. Independent restrictions/occupancy products may still require distinct rates.
4. Verify equivalence using a controlled staging receiver and the relevant real
   OTA's mapping/readback evidence. OpenChannel proof does not establish Expedia
   or Agoda behavior. Record unsupported combinations and stop the migration if
   equivalence or mapping identity is uncertain.
5. Obtain explicit approval for the named property's concrete mapping changes,
   final-price comparison and rollback plan. Schedule the switch with a single
   operator, pause competing configuration edits, and retain the old snapshot.
   Record actor, time, before/after mappings and strategy in the audit trail.
6. Switch provider mappings and pricing ownership as a coordinated operation;
   do not leave Vayada and Channex applying the same adjustment. Confirm outgoing
   prices/restrictions and each channel's state immediately. A green connection
   badge is insufficient. Do not use a real reservation or payment as a probe.
7. If verification fails, restore the old provider mappings, Vayada strategy and
   both modifier layers from the snapshot, resynchronize and verify old final
   prices. Rehearse this rollback before approving the live switch. Keep old rates
   available until the operator accepts the result; deletion is a separate action.

The application currently exposes no bulk migration or one-click switch for this
procedure. Do not implement a metadata-only strategy change as a substitute for
provider mapping verification and rollback.
