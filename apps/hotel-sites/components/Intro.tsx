import type { HotelSite } from "@/sites/types";

export function Intro({ site }: { site: HotelSite }) {
  const { intro } = site;
  return (
    <section id="about" className="intro">
      <p className="eyebrow">{intro.eyebrow}</p>
      <h2>{intro.headline}</h2>
      <p className="intro-tagline">{intro.tagline}</p>
      <p className="intro-text">{intro.text}</p>
    </section>
  );
}
