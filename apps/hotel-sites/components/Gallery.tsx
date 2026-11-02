"use client";

import Image from "next/image";
import { useState } from "react";

import type { HotelSite } from "@/sites/types";

const pad = (value: number) => String(value).padStart(2, "0");

/** "Beyond your room": a big slide, switched by the thumbnails below it. */
export function Gallery({ gallery }: { gallery: HotelSite["gallery"] }) {
  const [active, setActive] = useState(0);
  const slide = gallery.slides[active] ?? gallery.slides[0];
  return (
    <section className="gallery" aria-label={gallery.eyebrow}>
      <p className="eyebrow">{gallery.eyebrow}</p>
      <div className="gallery-heading">
        <h2>
          {gallery.headline.map((line, index) => (
            <span key={index}>
              {index > 0 && <br />}
              {line}
            </span>
          ))}
        </h2>
        <p className="gallery-counter">
          {pad(active + 1)} / {pad(gallery.slides.length)}
        </p>
      </div>
      <div className="gallery-slide">
        <Image
          src={slide.image.src}
          alt={slide.image.alt}
          fill
          sizes="(max-width: 1376px) 100vw, 1280px"
        />
        <div aria-hidden="true" className="gallery-shade" />
        <div className="gallery-caption" aria-live="polite">
          <p className="gallery-label">{slide.label}</p>
          <h3>{slide.title}</h3>
          <p className="gallery-text">{slide.text}</p>
        </div>
      </div>
      <div className="gallery-thumbs">
        {gallery.slides.map((item, index) => (
          <button
            key={index}
            type="button"
            aria-pressed={index === active}
            onClick={() => setActive(index)}
          >
            <Image src={item.image.src} alt="" sizes="136px" />
            <span>
              {pad(index + 1)} {item.label}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
