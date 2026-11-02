import type { Metadata, Viewport } from "next";
import "./globals.css";
import { currentUser } from "@/lib/auth";
import { TabBar } from "@/components/TabBar";

export const metadata: Metadata = {
  title: "Far Post",
  description: "A friends-first fantasy football game.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f4f6" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  return (
    <html lang="en">
      <body>
        <header className="top">
          <div className="wrap">
            <a href="/" className="brand" aria-label="Far Post home">
              <span className="brand-mark" aria-hidden />
              Far Post
            </a>
            <nav className="top-links">
              {user?.is_admin && <a className="chip" href="/admin">Admin</a>}
              {user ? <a className="chip" href="/account">Account</a> : <a className="chip" href="/login">Sign in</a>}
            </nav>
          </div>
        </header>
        <main className="wrap">{children}</main>
        <footer className="footer">
          Far Post is an unofficial, invite-only game for friends. It is not affiliated with, endorsed by or connected to any league, club or player.
          <br />
          <a href="/privacy">Privacy</a>
        </footer>
        {user && <TabBar />}
      </body>
    </html>
  );
}
