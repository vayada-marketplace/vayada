import type { HotelSite } from "@/sites/types";

import { Split } from "./Split";

export function EatAndDrink({ eat }: { eat: HotelSite["eat"] }) {
  return (
    <section id="eat" className="tinted feature">
      <Split image={eat.image}>
        <p className="eyebrow">{eat.eyebrow}</p>
        <h2>
          {eat.headline.map((line, index) => (
            <span key={line}>
              {index > 0 && <br />}
              {line}
            </span>
          ))}
        </h2>
        <p>{eat.text}</p>
        {(eat.menusUrl || eat.tableUrl) && (
          <div className="text-links">
            {eat.menusUrl && (
              <a href={eat.menusUrl} className="text-link">
                View menus
              </a>
            )}
            {eat.tableUrl && (
              <a href={eat.tableUrl} className="text-link">
                Book a table
              </a>
            )}
          </div>
        )}
      </Split>
    </section>
  );
}

export function Location({ site }: { site: HotelSite }) {
  const { location } = site;
  return (
    <section className="feature">
      <Split image={location.image}>
        <p className="eyebrow">{location.eyebrow}</p>
        <h2>{location.headline}</h2>
        <p>{location.text}</p>
        {location.exploreUrl && (
          <a href={location.exploreUrl} className="text-link">
            Explore {site.address.locality}
          </a>
        )}
      </Split>
    </section>
  );
}
