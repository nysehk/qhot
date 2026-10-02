import { useEffect } from "react";
import { useRevalidator } from "react-router";

/** Refresh a visible finance feed at its head without interrupting readers further down. */
export function useFinanceRefresh(enabled: boolean) {
  const { revalidate, state } = useRevalidator();
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && window.scrollY < 200 && state === "idle") void revalidate();
    }, 15000);
    return () => clearInterval(timer);
  }, [enabled, revalidate, state]);
}
