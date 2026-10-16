# Cloudflare beacon pin runbook

`apps/landing/lib/cloudflareAnalytics.ts` loads Cloudflare's Web Analytics beacon
(`https://static.cloudflareinsights.com/beacon.min.js`) with an SRI hash. Cloudflare cannot
version-pin that URL, so each Cloudflare release changes the bytes. Browsers then refuse to run
it, and Cloudflare analytics on vayada.com stays off until the pin is updated. Nothing leaks: the
pin fails closed. Do not drop SRI and do not self-host the beacon. This repository is public: never
commit Cloudflare's file, only its hash and the reviewed record below.

## How you find out

- The daily **Cloudflare Beacon Drift** workflow (`.github/workflows/cloudflare-beacon-drift.yml`)
  opens the issue "Cloudflare beacon changed: review and update the landing SRI pin" (label
  `monitoring`) and fails. Compared with the reviewed record
  `scripts/ci/cloudflare-beacon-reviewed.json`, the issue lists the versions, the new hash,
  endpoint and transport counts (⚠️ marks a change) and how many statements changed. It never
  quotes Cloudflare's code.
- The same run prepares the fix (`scripts/ci/cloudflare-beacon-fix.mjs`), and the issue links it:
  - the branch `automation/cloudflare-beacon-pin-main` holds one commit that sets the new hash in
    `cloudflareAnalytics.ts` and regenerates the reviewed record;
  - PR Checks run on that branch. Pushes and pull requests made with the workflow's
    `GITHUB_TOKEN` start no workflows, so the job starts PR Checks with `workflow_dispatch`, an
    event that token may still trigger. The checks land on the branch's head commit;
  - one pull request from that branch. The workflow opens it only if the repository allows
    "GitHub Actions to create and approve pull requests" (Settings → Actions → General). If not,
    the issue links the page that opens it. The commit message becomes its description. From a
    terminal: `gh pr create --base main --head automation/cloudflare-beacon-pin-main --fill`.
  - When the branch moves under an open pull request (Cloudflare shipped again), the job comments
    the new report on it: review that one. A pull request closed without merging is not opened
    again for the same commit. A live version older than the reviewed one (edges mid-rollout)
    gets no fix.
  - When the live file matches the pin again (the fix merged, or Cloudflare went back), the next
    run closes the issue, closes the pull request if still open, and deletes the branch.
- PR checks keep passing. The landing consent spec runs offline against a stub beacon it
  generates, so it never depends on Cloudflare's file.

## Update the pin

Normally: review the prepared pull request (step 2), then merge it (step 4). **Merging it deploys
the landing site.** Then do steps 5 and 6. Its PR Checks never run Cloudflare's new file (the
consent spec uses a stub), so they are not the review. The commit writes "pinned via Cloudflare
Beacon Drift after review" above the pin: merge only after step 2. Use steps 1 and 3 when no
pull request was prepared, or when the fix needs more than a new hash (for example, new guards).

1. **Download the new file** and check that its hash matches the issue's "New pin":

   ```sh
   curl -sS -D headers.txt -o new-beacon.min.js https://static.cloudflareinsights.com/beacon.min.js
   grep -iE '^(etag|last-modified|content-length):' headers.txt   # ETag holds the version
   printf 'sha384-%s\n' "$(openssl dgst -sha384 -binary new-beacon.min.js | base64)"
   ```

2. **Review the change.** Start from the issue's tables. For the full diff, get
   the reviewed version from the Wayback Machine (a snapshot from before the change) and check
   that its hash equals the old pin. The minified file is one line, so diff it statement by
   statement. Keep both files outside the repository:

   ```sh
   curl -sSL -o reviewed-beacon.min.js \
     'https://web.archive.org/web/YYYYMMDDid_/https://static.cloudflareinsights.com/beacon.min.js'
   printf 'sha384-%s\n' "$(openssl dgst -sha384 -binary reviewed-beacon.min.js | base64)"
   diff <(tr ';' '\n' < reviewed-beacon.min.js) <(tr ';' '\n' < new-beacon.min.js)
   ```

   The landing guards cover only `navigator.sendBeacon` and `XMLHttpRequest` to
   `https://cloudflareinsights.com/cdn-cgi/rum` and same-origin `/cdn-cgi/rum`. Check that the new
   version still uses only those. Also check that it adds no `fetch`, WebSocket, `new Image()`
   pixels, workers, `eval`, `new Function`, `document.write`, script injection, cookies or
   storage. If it adds any of them, stop. Analytics
   stays off until the guards in `cloudflareAnalytics.ts` and the consent spec cover the new
   behaviour. Never copy the hash without this review.

3. **Open one PR** with both changes:
   - set `integrity` in `apps/landing/lib/cloudflareAnalytics.ts` to the new hash, and update
     the comment above it (version and date);
   - regenerate the reviewed record (hashes and counts only, no vendor code):
     `node scripts/ci/cloudflare-beacon-drift.mjs --record new-beacon.min.js > scripts/ci/cloudflare-beacon-reviewed.json`;
   - in the PR body, give the version, Last-Modified, size, old and new hash, and what the diff
     changes. #3277 is an example.

   PR Checks fail if the record and the pin disagree (`scripts/ci/cloudflare-beacon-drift.test.mjs`).
   The consent spec uses its stub, so nothing in CI runs the new bytes: steps 2 and 5 are the
   checks of the real file.

4. **Merge.** Merging to `main` (through the merge queue; an open release-train-hold issue pauses
   it) runs Deploy Landing (`.github/workflows/deploy-landing.yml`). That workflow pushes the
   `vayada-landing` image to ECR as `latest`, and the App Runner service publishes it at
   vayada.com.

5. **Verify on vayada.com** once the App Runner deployment finishes. This is the only run of the
   real file under the guards. Use a private window with DevTools open:
   - after "Accept all", `beacon.min.js` loads, the console shows no integrity error, and a
     request goes to `/cdn-cgi/rum`;
   - after "Cookie settings" → "Necessary only", no further `/cdn-cgi/rum` requests go out.

6. **Close the loop.** Run Cloudflare Beacon Drift on `main` from the Actions tab (no input), or
   wait for the next daily run. It closes the issue when the live file matches the pin on `main`.
   A closed issue means `main` is current, not that vayada.com is: step 5 checks the site.

## Testing the alert

Run the workflow manually with `expected_integrity` set to any other `sha384-…` value. It opens
(or updates) the issue, marked as a test run, and fails. Close that issue by hand, or let the next
run on `main` close it. Do not test while a real drift issue is open: the test rewrites its
description until the next daily run. On branches other than `main`, a run without the input only
prints the report and never touches issues, so checking a pin-update branch cannot close the real
issue early.
