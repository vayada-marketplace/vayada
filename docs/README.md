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

**Automatic** (default): a push to `main` that touches `docs/docs/`, `docs/src/`, `docs/static/`, `docs/docusaurus.config.ts`, `docs/sidebars.ts`, or `docs/package.json` triggers `.github/workflows/deploy-docs.yml`, which builds, syncs to S3, and invalidates CloudFront via the OIDC deploy role.

**Manual** (fallback): `./deploy.sh` does the same thing locally. Requires AWS credentials with S3 + CloudFront permissions; the distribution ID is read from `terraform output` in `infra/`. Use this if the workflow is broken or you need to deploy from a non-`main` branch.

## Maintenance

Owners: whoever ships a feature owns updating the corresponding user-facing page in `docs/docs/`. If the docs would lie after your change, update them in the same commit.

See [`engineering/docs-layering.md`](engineering/docs-layering.md) for the full maintenance convention.
