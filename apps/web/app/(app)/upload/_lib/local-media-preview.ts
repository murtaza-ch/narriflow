/** Own the URL and player attachment for one effect lifetime, including Strict Mode replay. */
export function attachLocalMediaPreview(
  media: Pick<HTMLMediaElement, "src" | "load" | "removeAttribute">,
  file: File,
) {
  const url = URL.createObjectURL(file);
  media.src = url;
  media.load();
  return () => {
    media.removeAttribute("src");
    media.load();
    URL.revokeObjectURL(url);
  };
}
