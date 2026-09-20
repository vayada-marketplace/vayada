# Stable Marketplace affiliate links

VAY-1504 contract for the stable creator–hotel link. Read with
[published affiliate terms and creator agreements](marketplace-affiliate-agreements.md)
and [booking evidence](affiliate-booking-evidence-contract.md).

## Identity and ownership

Marketplace owns one opaque `linkId` and public token for an activated affiliate
agreement. The persisted binding contains the agreement and property IDs. It does
not duplicate or accept a creator ID, beneficiary, terms version or destination
from the browser. Those facts are resolved from the agreement and its immutable
history when a click is captured.

The token is a shareable locator, not authorization. Possession cannot grant hotel
or creator reads. Native tokens use `va_` followed by 22 base64url characters and
must be generated from at least 128 bits of server randomness. Retries resolve the
existing agreement binding instead of allocating another identity or token. A
second creator can only receive a different agreement and link.

The default relative path is `/r/{publicToken}`. Deployment origin is trusted server
configuration. Resolution chooses the exact saved booking destination through the
agreement's effective accepted terms; a request cannot supply or override a redirect
URL. A missing, invalid, paused or ended agreement produces no earning click.

## Source reporting and variants

The default link needs no platform tag. Capture records permitted browser referrer
evidence when available and reports `unknown` when it is absent. This is best-effort
source reporting and does not promise post-level or cross-device identification.

Creators may append one optional `campaign` label. It is 1–64 characters from
letters, digits, `.`, `_` and `-`, with an alphanumeric first and last character.
The label is reporting metadata only: it creates no link or agreement, changes no
beneficiary or destination, and supplies no eligibility fact. The same public token
must appear in default and labelled variants.

## Compatibility

Existing legitimate referral URLs remain valid through explicit server-owned alias
records that point to a canonical link. Import evidence must prove the legacy link's
original hotel and affiliate ownership before an alias is created. Public requests
cannot choose aliases, attach old codes to agreements or replace canonical tokens.
Aliases resolve through the same agreement, lifecycle and destination checks as the
canonical token and must never create a second beneficiary.

The public value contract above does not implement link creation or resolution.
Authorized creation, alias import, public resolution, click capture and lifecycle
commands are separate reviewable changes. Collaboration completion alone does not
modify the agreement or link; the independent agreement lifecycle remains authoritative.

## Initial canonical-link storage

Migrations 0324–0325 store one immutable canonical link for one exact activated agreement.
The row repeats only the agreement's participation, program and property scope so
composite foreign keys can reject substituted ownership; it does not store a creator,
terms version, destination or campaign label. The exact activation is required, and
database uniqueness prevents another link or token from replacing the canonical one.

The storage row alone does not activate or resolve a link. The internal creator command
locks the activated agreement, rechecks current creator ownership, and returns the same
identity on retries. New issuance stays blocked until a trusted lifecycle and booking-
destination readiness adapter is connected; existing links remain readable by their
authorized creator. The command uses server randomness and existing idempotency storage.
Compatibility aliases remain separate and need ownership proof before import.
