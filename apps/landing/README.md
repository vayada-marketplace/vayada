# vayada-landing

The target-stack **marketing / landing site** for vayada (Next.js App Router).

This app contains only public website pages — no authenticated app code.
Sign-up and log-in links point at Booking Admin.

## Pages

| Route                                                                               | Purpose                                   |
| ----------------------------------------------------------------------------------- | ----------------------------------------- |
| `/`                                                                                 | Home                                      |
| `/booking-engine`, `/pms`, `/partner-program`, `/pricing`                           | Product pages                             |
| `/about`, `/contact`                                                                 | Marketing                                 |
| `/imprint`, `/privacy`, `/terms`                                                    | Legal                                     |
| `/api/health`                                                                       | Health check (for the container platform) |

`/contact` submits to the public contact endpoint via `NEXT_PUBLIC_API_URL`.
`/hotel-creator-network`, `/creator-benefits` and `/hotel-benefits` forward to
the home page (the Marketplace was removed, VAY-2260).

## Develop

```bash
npm install
npm run dev      # http://localhost:3006
npm run build    # always run before declaring a change done
npm run lint
```

`NEXT_PUBLIC_API_URL` is the contact API. `NEXT_PUBLIC_VAYADA_API_URL` is still
passed at build time but no page reads it any more. See `.env.example` for local
targets.

## Deploy

[`deploy-landing.yml`](../../.github/workflows/deploy-landing.yml) builds the
Next.js `standalone` image and pushes `latest` plus an immutable commit-SHA tag
to the `vayada-landing` ECR repository after landing changes merge to `main`.
The existing `vayada-landing` App Runner service watches `latest` and publishes
it at `vayada.com`.

`vayada.com` is the shared public landing surface. Deploying it does not change
the separate application or API hostnames. No DNS change is required for a
normal landing deployment.
