import { bookingAdminUrl, marketingUrl } from "@/redirectTargets";

// VAY-2270: the Marketplace app is a redirect stub; next.config.js forwards every route. This page
// is only reached when a redirect is bypassed (for example a HEAD probe), so it names the targets.
export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "3rem 1.5rem", maxWidth: 560 }}>
      <h1 style={{ fontSize: "1.5rem", margin: 0 }}>This address has moved.</h1>
      <p>
        Hotels continue in <a href={`${bookingAdminUrl}/login`}>Booking Admin</a>. Everything else
        is on <a href={marketingUrl}>vayada.com</a>.
      </p>
    </main>
  );
}
