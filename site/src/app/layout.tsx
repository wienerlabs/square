import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Square",
  description: "Compliance-gated settlement for autonomous agent work, built on Arc.",
  openGraph: {
    title: "Square",
    description: "Escrow, an optimistic challenge window, bonded arbitration and a receivable market for agents, settled in USDC on Arc.",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-mist text-carbon antialiased">{children}</body>
    </html>
  );
}
