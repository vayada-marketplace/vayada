import type { HotelSite } from "@/sites/types";

export function Footer({ site }: { site: HotelSite }) {
  const { footer } = site;
  return (
    <footer id="contact" className="footer">
      <div className="footer-inner">
        <h2>{footer.headline}</h2>
        <a href={site.bookingUrl} className="button-light">
          {footer.cta}
        </a>
        <div className="footer-meta">
          <span>{site.name}</span>
          <span>
            {site.address.locality}, {site.address.country}
          </span>
          {footer.instagramUrl && <a href={footer.instagramUrl}>Instagram</a>}
          {footer.contactUrl && <a href={footer.contactUrl}>Contact</a>}
        </div>
      </div>
    </footer>
  );
}
