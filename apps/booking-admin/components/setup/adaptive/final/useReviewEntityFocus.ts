"use client";
import { useEffect, useRef } from "react";

/** Focus once after the owner workspace has rendered the requested entity. */
export function useReviewEntityFocus(elementId: string | null | undefined, ready: boolean) {
  const focused = useRef<string | null>(null);
  useEffect(() => {
    if (!elementId) {
      focused.current = null;
      return;
    }
    if (!ready || focused.current === elementId) return;
    const element = document.getElementById(elementId);
    if (!element) return;
    focused.current = elementId;
    element.focus();
    element.scrollIntoView({ block: "center" });
  }, [elementId, ready]);
}
