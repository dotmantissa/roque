import type { Metadata, Viewport } from "next";
import { Inter, Space_Grotesk, JetBrains_Mono } from "next/font/google";
import { Providers } from "@/providers/Providers";
import { themeBootScript } from "@/providers/ThemeProvider";
import "@/styles/globals.css";

// Body copy in a clean grotesque, headings and the wordmark in something with a
// little more shoulder, and numbers in a mono so a column of prices lines up.
const inter = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const display = Space_Grotesk({ subsets: ["latin"], variable: "--font-display", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: {
    default: "Roque · trade by talking",
    template: "%s · Roque",
  },
  description:
    "Roque is an agent native exchange on Sepolia. Say what you want in plain words. A judgment layer reads it, deterministic contracts decide, and you stay in control of every coin.",
  applicationName: "Roque",
  keywords: ["Roque", "DEX", "agent", "Sepolia", "GenLayer", "on-chain trading"],
  authors: [{ name: "Roque" }],
  openGraph: {
    title: "Roque · trade by talking",
    description:
      "An agent native exchange. You speak, Roque reads, the chain decides. Your keys never leave your hands.",
    siteName: "Roque",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Roque · trade by talking",
    description: "An agent native exchange where you trade in plain words and keep your keys.",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f7f9" },
    { media: "(prefers-color-scheme: dark)", color: "#17191b" },
  ],
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body className={`${inter.variable} ${display.variable} ${mono.variable}`}>
        <Providers>
          {children}
        </Providers>
      </body>
    </html>
  );
}
