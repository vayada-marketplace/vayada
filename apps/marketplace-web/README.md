# marketplace-web (redirect stub)

The creator Marketplace was removed (VAY-2259). Until its service and addresses go in step 4
(VAY-2271), this app is a redirect stub so the coordinated release still builds six images:

- `/api/health` answers for the load balancer;
- `/auth/[...path]` keeps the first-party login gateway contract (`AUTH_PUBLIC_ORIGIN`,
  `AUTH_GATEWAY_UPSTREAM_ORIGIN`);
- every former route forwards (302) to Booking Admin (`NEXT_PUBLIC_BOOKING_ADMIN_URL`) for hotel
  pages or to vayada.com (`NEXT_PUBLIC_MARKETING_URL`) for everything else; see `next.config.js`.

Run locally: `npm run dev:marketplace-web`. Tests: `npm --workspace vayada-creator-marketplace run test`
(the redirect table in `redirects.test.ts`, the login gateway in `app/auth/[...path]/route.test.ts`).
