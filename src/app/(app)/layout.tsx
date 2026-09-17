import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { AppShell } from "../_components/AppShell";

/** Every authenticated page sits under this layout, so every one of them gets
    the same header. /login and /register live in (auth) and stay bare. */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect("/login");

  return (
    <>
      <AppShell email={user.email} />
      {children}
    </>
  );
}
