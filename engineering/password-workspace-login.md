# Password workspace selection

Prepared hotel invitations can give an existing hotel owner a second organization.
WorkOS then requires organization selection before issuing a password session.
Marketplace must show the provider-offered workspaces and complete the selected
workspace login; session refresh cannot complete authentication before cookies exist.

Marketplace retains the submitted credentials only in a component ref while the
workspace chooser is open. Selecting a workspace retries password authentication
with its ID. Successful authentication, changing account, and unmounting clear the
ref. Credentials and pending authentication tokens are never persisted.

The API accepts a requested workspace only when offered by WorkOS for the current
password authentication, and checks that both the provider session and resolved
identity remain in the requested workspace. Existing active user, membership,
surface, role, and resource checks remain mandatory. A mismatched workspace fails
without session cookies. Login without a requested workspace retains its existing
behavior, including selection for an already authenticated session.

Validation includes API denial cases and a browser regression for choosing the
second workspace and returning to an empty login form after a failed retry.
Real-account validation resumes the prepared import smoke after deployment.
