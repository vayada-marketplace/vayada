# vayada docs

Internal Docusaurus site for the Vayada team. Source-of-truth for **user-facing operational guides**: custom domains, hotel onboarding, booking engine, etc.

This is one of three docs layers in the monorepo. See [`engineering/docs-layering.md`](engineering/docs-layering.md) for what belongs where.

## Develop

```bash
# From the repo root
npm install                  # installs the docs workspace too
npm run dev:docs             # starts the Docusaurus dev server
```

Or from inside this directory:

```bash
npm run start
```

The dev server lives on its own port (usually 3007) and hot-reloads on save.

## Build

```bash
npm run build:docs           # from repo root
# or
npm run build                # from docs/
```

Output goes to `docs/build/`.

## Add a page

1. Drop a Markdown file under `docs/docs/<section>/<page>.md`. Frontmatter is optional; if omitted, Docusaurus generates a slug from the path.
2. Reference it in `sidebars.ts` so it appears in the left navigation.
3. Run `npm run dev:docs` and verify it renders.

For broken links, Docusaurus is configured with `onBrokenLinks: 'throw'`, so missing references fail the build (not just a warning).

## Deploy

The site is deployed as a static bundle to S3 + CloudFront. Infra is in `infra/docs.tf`; the bucket is `s3://vayada-docs` and the public URL is `https://docs.vayada.com`.

```bash
./deploy.sh           # build, sync to S3, invalidate CloudFront
```

Requires AWS credentials with access to the docs S3 bucket and the CloudFront distribution (the distribution ID is read from `terraform output` in `infra/`).

This is currently a manual deploy. Migrating it to a GitHub Actions workflow with path filters (matching the pattern in `docs/engineering/monorepo-deploy-workflows.md`) is a known follow-up.

## Maintenance

Owners: whoever ships a feature owns updating the corresponding user-facing page in `docs/docs/`. If the docs would lie after your change, update them in the same commit.

See [`engineering/docs-layering.md`](engineering/docs-layering.md) for the full maintenance convention.
