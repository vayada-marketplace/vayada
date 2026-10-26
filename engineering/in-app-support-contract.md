# In-app support — VAY-1008

Implements [VAY-1008](https://linear.app/vayadacom/issue/VAY-1008) against the
[TypeScript backend structure](typescript-backend-structure.md). No legacy API changes.

`POST /api/support` accepts `kind` (`support` or `bug`), `message` (1–4000 trimmed
characters), `product` (booking or pms) and `page` (a local
pathname, at most 500 characters; no query, fragment or URL). Identity and selected
organization come only from the resolved RequestContext. This is an explicit
identity-only exception to product route policy: support requires no paid product
entitlement, resource link or product permission. Authentication still requires an
active resolved identity and organization membership.

The existing PL1 contact intake repository atomically commits a domain event, its
notification job and its audit record. Since VAY-2286 the private message, identity
and context live only in the job row (`platform.jobs.payload`), which is emptied 90
days after arrival; the append-only event and audit rows hold only the channel
(`in_app_support`) and outcome.
Success means stored, not email delivered. Since VAY-2286 the contact notification
worker emails each request to `CONTACT_NOTIFICATION_RECIPIENT` (Reply-To: the
requester; subject: kind, app and the organization's name, stored with the request
as `organizationName`).
Identical submissions reuse the existing hourly deduplication key; retry across
an hour boundary can produce another request. Response: 201 `{status: "accepted",
reference}`; 400 invalid input, 401 missing/invalid identity, 503 storage failure.
Errors retain the client draft; requests time out after 20 seconds.

The shared form appears in authenticated Booking Admin and PMS navigation.
Legacy builds with `NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED=false` hide it.

VAY-1007 remains Backlog and no help/docs page exists in main. The docs navigation
criterion is deferred to that dependency; no unavailable help link is rendered.
The existing `support@vayada.com` reference is in ProfileCompletionScreen, but this
implementation relies on durable intake rather than assuming mailbox delivery.
