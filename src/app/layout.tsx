import type { Metadata } from "next";
import { ServiceWorker } from "./_components/ServiceWorker";
import "./globals.css";

export const metadata: Metadata = {
  title: "The Overboard",
  description: "Personal mega-kanban for tracking too many projects at once.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
