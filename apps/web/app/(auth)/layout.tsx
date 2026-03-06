import Link from "next/link";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-10 text-foreground">
      <div className="w-full max-w-md space-y-6 rounded-xl border border-border bg-card p-6 shadow-sm">
        <div className="space-y-2 text-center">
          <Link href="/" className="text-sm font-semibold tracking-tight">
            Narriflow
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">Welcome to Narriflow</h1>
          <p className="text-sm text-muted-foreground">
            Sign in or create an account to continue turning long-form content into social-ready assets.
          </p>
        </div>
        {children}
      </div>
    </main>
  );
}
