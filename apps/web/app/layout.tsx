import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { ClerkProvider } from "@clerk/nextjs";
import ClerkHeader from "./components/ClerkHeader";

export const metadata: Metadata = {
  title: "The Foundry",
  description: "AI-powered task orchestration for your repos",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-zinc-950 text-zinc-100">
        <ClerkProvider>
          <nav className="border-b border-zinc-800 bg-zinc-900">
            <div className="mx-auto flex max-w-6xl items-center gap-8 px-6 py-4">
              <Link href="/" className="text-lg font-bold tracking-tight">
                The Foundry
              </Link>
              <Link href="/projects" className="text-sm text-zinc-400 hover:text-zinc-100">
                Projects
              </Link>
              <div className="ml-auto">
                <ClerkHeader />
              </div>
            </div>
          </nav>
          <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
        </ClerkProvider>
      </body>
    </html>
  );
}
