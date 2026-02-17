import Link from "next/link";

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="text-sm font-semibold tracking-tight">
            ClipForge
          </Link>
          <nav className="flex items-center gap-4 text-sm text-muted-foreground">
            <Link href="/pricing">Pricing</Link>
            <Link href="/dashboard">App</Link>
          </nav>
        </div>
      </header>
      {children}
    </div>
  );
}
