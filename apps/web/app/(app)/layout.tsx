import Link from "next/link";
import { getCurrentAppUser } from "@narriflow/auth";
import { redirect } from "next/navigation";
import { AccountMenu } from "./_components/account-menu";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const appUser = await getCurrentAppUser();

  if (!appUser) {
    redirect("/sign-in");
  }

  if (!appUser.onboardingCompletedAt) {
    redirect("/onboarding");
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/dashboard" className="text-sm font-semibold tracking-tight">
            Narriflow App
          </Link>
          <div className="flex items-center gap-4">
            <nav className="flex items-center gap-4 text-sm text-muted-foreground">
              <Link href="/dashboard">Dashboard</Link>
              <Link href="/upload">Upload</Link>
              <Link href="/projects">Projects</Link>
              <Link href="/">Marketing</Link>
            </nav>
            <AccountMenu
              email={appUser.primaryEmail}
              firstName={appUser.firstName}
              imageUrl={appUser.imageUrl}
              lastName={appUser.lastName}
            />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
