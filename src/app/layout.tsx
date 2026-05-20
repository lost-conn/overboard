import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Overboard Organizer",
  description: "Personal mega-kanban for tracking too many projects at once.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
