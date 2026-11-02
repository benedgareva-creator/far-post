"use client";
import { usePathname } from "next/navigation";

const I = {
  home: <path d="M4 11.5 12 5l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z" />,
  team: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" /></>,
  transfers: <><path d="M5 8h13l-3.5-3.5" /><path d="M19 16H6l3.5 3.5" /></>,
  matches: <><rect x="3.5" y="5" width="17" height="14" rx="2.5" /><path d="M12 5v14" /><circle cx="12" cy="12" r="2.6" /></>,
  leagues: <><path d="M7 4h10v5a5 5 0 0 1-10 0z" /><path d="M12 14v3.5M8.5 20.5h7M17 6h2.5v1.5A3 3 0 0 1 17 10.4M7 6H4.5v1.5A3 3 0 0 0 7 10.4" /></>,
};

const TABS: [string, string, keyof typeof I][] = [
  ["/", "Scores", "home"],
  ["/team", "My team", "team"],
  ["/transfers", "Transfers", "transfers"],
  ["/matches", "Matches", "matches"],
  ["/leagues", "Leagues", "leagues"],
];

export function TabBar() {
  const path = usePathname();
  return (
    <nav className="tabs" aria-label="Main">
      <div className="wrap">
        {TABS.map(([href, label, icon]) => {
          const on = href === "/" ? path === "/" : path.startsWith(href);
          return (
            <a key={href} href={href} className={`tab${on ? " on" : ""}`} aria-current={on ? "page" : undefined}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                {I[icon]}
              </svg>
              {label}
            </a>
          );
        })}
      </div>
    </nav>
  );
}
