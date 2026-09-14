# Channel inventory rules

VAY-1531 extends [PMS Channex management](pms-channex-management-contract.md).
Only the TypeScript system changes. PMS owns desired rules in the existing
Channex connection metadata; platform jobs own delivery and operation status.

## Provider semantics

The official [API reference](https://docs.channex.io/api-v.1-documentation/availability-rules-collection)
and [behavior guide](https://docs.channex.io/application-documentation/availability-rules)
were checked on 2026-09-07. They define `availability_offset`, `max_availability`,
and `close_out`, scoped by channel UUID, mapped room UUID, inclusive dates and
optional weekdays. Offsets subtract a positive number, caps replenish as shared
availability changes, and close-outs expose zero. Vayada never subtracts these
rules from canonical inventory or modifies reservations.

Neither reference defines overlap precedence. Vayada rejects rules sharing any
channel, room and effective date, including overlapping unmanaged provider rules.
Staff must edit or remove the conflicting rule. Different weekdays may coexist.
Scope swaps that would overlap a retained provider rule during sequential PUTs
are also rejected before writes. Move or remove the conflicting rule first.
The [Channel API](https://docs.channex.io/api-v.1-documentation/channel-api)
uses `channel` adapter codes and `properties` membership arrays; preserve channel
UUIDs and validate membership rather than assuming a single-property relation.

## Command and synchronization

`PUT /api/pms/properties/:propertyId/channex/inventory-rules` replaces the desired
rule set using command identity, expected previous operation ID, and stable rule
UUIDs. The existing manage permission, property entitlement/resource policy and
ARI mutation capability apply. Validate active channel IDs and active mapped room
types under the current property before accepting. Commit desired state and a
durable `update_inventory_rules` job atomically. Concurrent stale edits return 409.

The snapshot exposes desired rules and their latest operation, including terminal
failures. Pending or failed changes are never labeled applied. Retry submits the
current desired set with a new command identity and the current operation ID.

Workers serialize management provider calls per property, reload current desired
state on retry, paginate provider reads, and reconcile stable Vayada rule titles.
A lost create response is recovered by listing before creating again. Update uses
PUT; removal uses DELETE and accepts an already-absent rule. Only provider rules
owned by this property's Vayada prefix may be removed. Provider rule scope and
current connected channels are checked before writes. Existing ARI jobs continue
to send actual shared inventory; Channex applies its rules on each change.

## UI and evidence

Show selected and excluded channels for offsets. Only all-channel coverage can
be described as keeping the last rooms for direct bookings. Explain that maximum
availability is a ceiling, not a total sales quota. Show dates, weekdays, room
types, values and synchronization state; support create/edit/remove/retry.

Mocked tests validate contracts and recovery. Completion also requires bounded
PMS UI and Channex staging evidence for all three types, inventory changes and
removal; provider acceptance and observed OTA enforcement are distinct evidence.
No real guest bookings or production provider mutations are authorized.
