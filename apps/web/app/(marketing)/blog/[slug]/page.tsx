export default async function BlogPostPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Blog: {slug}</h1>
      <p className="mt-3 text-muted-foreground">CMS integration placeholder for marketing content.</p>
    </main>
  );
}
