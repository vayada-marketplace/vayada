"use client";

import { useEffect } from "react";

const SETTLE_MS = 4000;
const USER_INPUT = ["wheel", "touchstart", "keydown", "pointerdown"] as const;

/**
 * Scrolls to `#section` (search results and old Settings links point at sections). Sections above
 * it load their data afterwards and push it down, so it stays in view while the page settles, until
 * the user scrolls or clicks.
 */
export function useScrollToHash() {
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (!id) return;
    let frame = 0;
    const scroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() =>
        document.getElementById(id)?.scrollIntoView({ block: "start" }),
      );
    };
    const observer = new MutationObserver(scroll);
    const stop = () => {
      observer.disconnect();
      clearTimeout(timer);
      for (const event of USER_INPUT) window.removeEventListener(event, stop);
    };
    const timer = setTimeout(stop, SETTLE_MS);
    for (const event of USER_INPUT) window.addEventListener(event, stop, { passive: true });
    observer.observe(document.querySelector("main") ?? document.body, {
      childList: true,
      subtree: true,
    });
    scroll();
    return () => {
      stop();
      cancelAnimationFrame(frame);
    };
  }, []);
}
