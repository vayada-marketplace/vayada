import localFont from "next/font/local";

// PLACEHOLDERS (VAY-2422). Every photo and the font below come from Timo's design export: low-res
// cut-outs and Jost, which the design only borrowed. The hotel's real photos and brand font are in
// the client's Drive folder. To swap them, add the files next to this one and change only the
// imports here; content.ts reads everything through this file.
import beach from "./placeholder/beach.jpg";
import elephant from "./placeholder/elephant.jpg";
import giraffe from "./placeholder/giraffe.jpg";
import hero from "./placeholder/hero.jpg";
import leopard from "./placeholder/leopard.jpg";
import restaurant from "./placeholder/restaurant.jpg";
import tiger from "./placeholder/tiger.jpg";

export const photos = { hero, tiger, leopard, giraffe, elephant, restaurant, beach };

export const brandFont = localFont({
  src: "./placeholder/jost.woff2",
  weight: "300 500",
  display: "swap",
  variable: "--site-font",
});
