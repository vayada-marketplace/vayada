# vayada-landing

The public **marketing / landing site** for vayada (Next.js 14, App Router).

Split out of `vayada-creator-marketplace-frontend` so the marketing surface and
the authenticated creator marketplace app evolve as independent projects. This
repo contains only public website pages — no authenticated app code.

## Pages

| Route | Purpose |
|---|---|
| `/` | Home |
| `/booking-engine`, `/pms`, `/hotel-creator-network`, `/partner-program`, `/pricing` | Product pages |
| `/about`, `/contact`, `/creator-benefits`, `/hotel-benefits` | Marketing |
| `/imprint`, `/privacy`, `/terms` | Legal |
| `/api/health` | Health check (for the container platform) |

`/hotel-creator-network` pulls live creators/hotels from the marketplace
backend API (cross-origin, like the contact form) — see `NEXT_PUBLIC_API_URL`.

The `/choose-product` login router stays in `vayada-creator-marketplace-frontend`
(it's part of the auth flow, linked from `/login`). The marketing chrome
(`Navigation`, `Footer`, `LandingFooter`) is intentionally duplicated in both
repos because app pages (`/hotels/[id]`, `/choose-product`, `/creators`,
`/properties`) still use it.

## Develop

```bash
npm install
npm run dev      # http://localhost:3006
npm run build    # always run before declaring a change done
npm run lint
```

`NEXT_PUBLIC_API_URL` points the contact form + HCN data fetch at the
marketplace backend (`http://localhost:8000` locally, `https://api.vayada.com`
in prod). See `.env.example`.

## Deploy

`Dockerfile` builds a Next.js `standalone` image. `.github/workflows/deploy.yml`
pushes to ECR repo **`vayada-landing`** on push to `main`; the container
platform auto-deploys. ECR repo + service + DNS are provisioned in the parent
repo's `infra/` (Terraform) — pending the domain cutover.
