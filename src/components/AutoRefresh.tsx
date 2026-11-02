"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-reads saved points from our own server every 30 seconds (never from the data supplier). */
export function AutoRefresh({ seconds = 30 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, seconds * 1000);
    return () => clearInterval(t);
  }, [router, seconds]);
  return null;
}
