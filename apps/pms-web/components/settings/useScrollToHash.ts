"use client";

import { useEffect } from "react";

/** Scrolls to `#section` once the page has rendered it (search results link to sections). */
export function useScrollToHash() {
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id) document.getElementById(id)?.scrollIntoView({ block: "start" });
  }, []);
}
