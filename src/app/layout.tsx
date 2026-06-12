import type { Metadata } from "next";
import { IBM_Plex_Sans_Thai } from "next/font/google";
import { profile } from "@/content/profile";
import "./globals.css";

const sans = IBM_Plex_Sans_Thai({
  variable: "--font-sans",
  subsets: ["latin", "thai"],
  weight: ["400", "500", "600", "700"],
});

// || not ?? — Docker build args arrive as empty strings, not undefined.
// Default to the real domain: it's public info, and --source deploys
// can't pass build args, so the fallback IS production's value.
const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL || "https://www.nutthapongkanna.com";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: `${profile.name} — ${profile.role}`,
    template: `%s — ${profile.name}`,
  },
  description: profile.tagline,
  openGraph: {
    type: "profile",
    title: `${profile.name} — ${profile.role}`,
    description: profile.tagline,
    url: siteUrl,
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={sans.variable}>
        {/* Apply the saved theme before anything paints — prevents the
            light-flash on reload for users who chose light mode */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{if(localStorage.getItem("theme")==="light")document.documentElement.dataset.theme="light"}catch(e){}`,
          }}
        />
        {children}
      </body>
    </html>
  );
}
