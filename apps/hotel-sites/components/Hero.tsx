import type { HotelSite } from "@/sites/types";

import { Photo } from "./Photo";

export function Hero({ site }: { site: HotelSite }) {
  const { hero } = site;
  return (
    <header id="top" className="hero">
      <Photo
        src={hero.image.src}
        alt={hero.image.alt}
        fill
        preload
        sizes="100vw"
        className="hero-image"
      />
      <div aria-hidden="true" className="hero-shade" />
      <nav aria-label="Main" className="nav">
        <a href="#top" className="nav-brand">
          {site.name}
        </a>
        <div className="nav-links">
          {site.nav.map((item) => (
            <a key={item.href} href={item.href}>
              {item.label}
            </a>
          ))}
        </div>
      </nav>
      <div className="hero-body">
        <h1>{hero.headline}</h1>
        <p className="hero-subline">{hero.subline}</p>
        <a href={site.bookingUrl} className="button-light">
          {hero.cta}
        </a>
      </div>
    </header>
  );
}
