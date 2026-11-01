import type { HotelSite } from "@/sites/types";

/** "Loved by our guests": real reviews only; the page leaves it out while the site has none. */
export function Reviews({ reviews }: { reviews: NonNullable<HotelSite["reviews"]> }) {
  return (
    <section className="tinted reviews">
      <div className="reviews-inner">
        <h2>{reviews.heading}</h2>
        <div className="review-list">
          {reviews.items.map((review) => (
            <figure key={`${review.author}-${review.source}`}>
              <p role="img" aria-label={`${review.rating} out of 5 stars`} className="stars">
                {"★".repeat(review.rating)}
              </p>
              <blockquote>{review.text}</blockquote>
              <figcaption>
                {review.author}
                <br />
                {review.origin} · {review.source}
              </figcaption>
            </figure>
          ))}
        </div>
        {reviews.moreUrl && (
          <a href={reviews.moreUrl} className="text-link">
            Read more reviews
          </a>
        )}
      </div>
    </section>
  );
}
