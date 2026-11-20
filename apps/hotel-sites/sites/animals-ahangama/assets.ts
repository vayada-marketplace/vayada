import localFont from "next/font/local";

// The hotel's photos (Timo's folder "4. Pictures for Website", VAY-2465), one file per slot,
// converted to sRGB and cropped for it: a portrait photo in a landscape slot keeps the part named.
// The hotel left the order to us ("Bilder Anordnung ist erstmal egal").
import bar from "./photos/bar.jpg"; // Animlas-1533, the counter and stools
import cowork from "./photos/cowork.jpg"; // Animals-7322, the laptop on the desk
import eat from "./photos/eat.jpg"; // DSC_6820
import elephant from "./photos/elephant.jpg"; // the villa's rendering (WhatsApp, 8 Aug 2026)
import evenings from "./photos/evenings.jpg"; // Animals-7912-2, the diners under the lights
import giraffe from "./photos/giraffe.jpg"; // DSC00961, its black frame trimmed (as Room 8)
import hero from "./photos/hero.jpg"; // DSC09067, from Display P3
import leopard from "./photos/leopard.jpg"; // DSC08803, its black frame trimmed (as Room 5–6)
import location from "./photos/location.jpg"; // animals-7776, the palms
import lounge from "./photos/lounge.jpg"; // DSC_5879, the chairs
import play from "./photos/play.jpg"; // DSC_6121, the chess board and fruit
import pool from "./photos/pool.jpg"; // DSC_5954, the guest in the pool
import restaurant from "./photos/restaurant.jpg"; // Animlas-7857, the pan over the flame
import slowMoments from "./photos/slow-moments.jpg"; // Animlas-1578, the coffee
import tiger from "./photos/tiger.jpg"; // DSC09162, its black frame trimmed (as Room 3)

export const photos = { hero, tiger, leopard, giraffe, elephant, eat, location };

export const galleryPhotos = {
  pool,
  cowork,
  play,
  lounge,
  restaurant,
  bar,
  slowMoments,
  evenings,
};

// Jost (latin subset, weights 300–500), the design's font; the hotel kept it. Copyright 2020 The
// Jost Project Authors (https://github.com/indestructible-type/Jost), SIL Open Font License 1.1
// (https://openfontlicense.org).
export const brandFont = localFont({
  src: "./jost.woff2",
  weight: "300 500",
  display: "swap",
  variable: "--site-font",
});
