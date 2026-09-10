import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { Providers } from "./providers";
import { ClockNotice } from "@/components/ClockNotice";
import { Footer } from "@/components/Footer";
import { NavPill } from "@/components/NavPill";
import { TxToast } from "@/components/TxToast";

export const metadata: Metadata = {
  title: { default: "Square", template: "%s | Square" },
  description: "Compliance-gated settlement for autonomous agent work on Arc.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-paper-white text-carbon">
        <Providers>
          <NavPill />
          <main className="mx-auto w-full max-w-[1200px] px-6 pb-16 pt-32">
            <ClockNotice />
            {children}
          </main>
          <Footer />
          <TxToast />
        </Providers>
      </body>
    </html>
  );
}
