/** Public configuration for the cloud file pickers on the upload page. A picker
 *  with missing configuration is simply absent from the page. */
export interface SourcePickerConfig {
  drive: { apiKey: string; clientId: string; appId: string } | null;
  dropboxAppKey: string | null;
}

export interface SourcePickerEnv {
  NEXT_PUBLIC_GOOGLE_API_KEY?: string;
  NEXT_PUBLIC_GOOGLE_CLIENT_ID?: string;
  NEXT_PUBLIC_GOOGLE_APP_ID?: string;
  NEXT_PUBLIC_DROPBOX_APP_KEY?: string;
}

export function sourcePickerConfig(env: SourcePickerEnv): SourcePickerConfig {
  const apiKey = env.NEXT_PUBLIC_GOOGLE_API_KEY?.trim();
  const clientId = env.NEXT_PUBLIC_GOOGLE_CLIENT_ID?.trim();
  const appId = env.NEXT_PUBLIC_GOOGLE_APP_ID?.trim();
  return {
    drive: apiKey && clientId && appId ? { apiKey, clientId, appId } : null,
    dropboxAppKey: env.NEXT_PUBLIC_DROPBOX_APP_KEY?.trim() || null,
  };
}

const scripts = new Map<string, Promise<void>>();

/** Loads a third-party script once. A failed load can be retried. */
export function loadScript(
  src: string,
  attributes: Record<string, string> = {},
): Promise<void> {
  const known = scripts.get(src);
  if (known) return known;
  const loading = new Promise<void>((resolve, reject) => {
    const element = document.createElement("script");
    element.src = src;
    element.async = true;
    for (const [name, value] of Object.entries(attributes)) {
      element.setAttribute(name, value);
    }
    element.onload = () => resolve();
    element.onerror = () => {
      element.remove();
      scripts.delete(src);
      reject(new Error(`Could not load ${new URL(src).hostname}`));
    };
    document.head.appendChild(element);
  });
  scripts.set(src, loading);
  return loading;
}
