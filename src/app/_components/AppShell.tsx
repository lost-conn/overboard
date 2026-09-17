"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Settings } from "lucide-react";
import * as Popover from "@radix-ui/react-popover";
import { logoutAction } from "../(auth)/actions";
import styles from "./shell.module.css";

const PRIMARY = [
  { href: "/", label: "Board" },
  { href: "/ideas", label: "Ideas" },
  { href: "/shared", label: "Shared" },
] as const;

const SETTINGS = [
  { href: "/settings/board", label: "Board settings" },
  { href: "/settings/classes", label: "Schedule classes" },
  { href: "/settings/axes", label: "Component axes" },
  { href: "/settings/tokens", label: "API tokens" },
] as const;

/** "/" only matches itself; everything else matches its subtree. */
function isCurrent(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

/** The in-content page heading. Ideas, Shared and all three settings pages
    had their own identical copy of this; it lives here next to the shell
    because it is the other half of "what page am I on". */
export function PageHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: React.ReactNode;
}) {
  return (
    <div className={styles.pageHead}>
      <h1 className={styles.pageTitle}>{title}</h1>
      {subtitle ? <p className={styles.pageSubtitle}>{subtitle}</p> : null}
    </div>
  );
}

export function AppShell({ email }: { email: string }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const inSettings = pathname.startsWith("/settings");

  return (
    <header className={styles.header}>
      <Link href="/" className={styles.brand}>
        <Image src="/logo.png" alt="" width={24} height={24} className={styles.logo} priority unoptimized />
        <span className={styles.title}>The Overboard</span>
      </Link>

      <nav className={styles.nav} aria-label="Primary">
        {PRIMARY.map(({ href, label }) => {
          const current = isCurrent(pathname, href);
          return (
            <Link
              key={href}
              href={href}
              className={styles.navLink}
              data-current={current || undefined}
              aria-current={current ? "page" : undefined}
            >
              {label}
            </Link>
          );
        })}

        <Popover.Root open={open} onOpenChange={setOpen}>
          <Popover.Trigger asChild>
            <button
              type="button"
              className={styles.navBtn}
              data-current={inSettings || undefined}
              aria-current={inSettings ? "page" : undefined}
              aria-label="Settings and account"
            >
              <Settings size={15} aria-hidden />
              <span className={styles.navBtnLabel}>Settings</span>
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content className={styles.menu} align="end" sideOffset={6}>
              {SETTINGS.map(({ href, label }) => {
                const current = isCurrent(pathname, href);
                return (
                  <Link
                    key={href}
                    href={href}
                    className={styles.menuItem}
                    data-current={current || undefined}
                    aria-current={current ? "page" : undefined}
                    onClick={() => setOpen(false)}
                  >
                    {label}
                  </Link>
                );
              })}
              <div className={styles.menuDivider} />
              <div className={styles.menuEmail}>{email}</div>
              <form action={logoutAction}>
                <button type="submit" className={styles.menuItem}>
                  Sign out
                </button>
              </form>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </nav>
    </header>
  );
}
