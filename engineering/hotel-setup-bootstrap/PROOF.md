# Reviewed operational bootstrap inputs

The pair `vay965-launch-save-20261003` pins primary source `d51cb02975995ffd8388958e295e23ae63474fd7` (app2799) and rollback source `b83da0787e098d59490b48b392967cb6d67b97b7` (app2798). Both retain the reviewed public admission composition; primary adds the fixed-root operational CLI.

Normal immutable publication runs [37117845929](https://github.com/vayada-marketplace/vayada/actions/runs/37117845929) and [37117724806](https://github.com/vayada-marketplace/vayada/actions/runs/37117724806) succeeded. Public deploy dispatch was skipped for both. OCI revisions were inspected and match the input sources.

On 2026-10-03, the exact packaging Dockerfile bundled those two distinct immutable images into `/app` and `/proof/rollback`. Fresh owned TLS PostgreSQL16 and17 databases were migrated by the actual primary image to final schema0462. Both passed the committed synthetic compiled CLI harness: all four native purposes, duplicate refusal, secondary proof failure, wrong AWS account, lost publication response cleanup, and no business writes. The harness and AWS preload were mounted separately; they are excluded from the packaged image. Synthetic credentials and publication payloads were kept private.

This approves only the input image pair for operational packaging. The normal-CI-published operational image still requires manifest/source verification and native proof before its digest enters the platform runner inventory. It does not confirm deployment, real credential publication, or recovery of either reported Owner account.
