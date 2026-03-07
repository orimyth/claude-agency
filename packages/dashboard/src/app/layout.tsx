import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@/components/sidebar";
import { ThemeProvider } from "@/components/theme-provider";
import { ToastProvider } from "@/components/toast";
import { CommandPaletteProvider } from "@/components/command-palette";
import { EmergencyBanner } from "@/components/emergency-banner";
import { WSProvider } from "@/components/ws-provider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Claude Agency — Dashboard",
  description: "Autonomous AI Agency Dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-gray-50 dark:bg-[#0f1117] transition-colors duration-300`}
      >
        <ThemeProvider>
          <ToastProvider>
            <WSProvider>
              <CommandPaletteProvider>
                <div className="flex min-h-screen">
                  <Sidebar />
                  <div className="flex-1 flex flex-col overflow-auto">
                    <EmergencyBanner />
                    <main className="flex-1 p-8">{children}</main>
                  </div>
                </div>
              </CommandPaletteProvider>
            </WSProvider>
          </ToastProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
