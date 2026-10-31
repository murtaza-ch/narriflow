/** Native renderers receive these ports backed by attempt-scoped grants. */
export type PutFileFromPath = (input: { key: string; filePath: string; contentType?: string; metadata?: Record<string, string>; signal?: AbortSignal }) => Promise<{ key: string; fileName: string }>;
export type DownloadObjectToFile = (input: { key: string; filePath: string; signal?: AbortSignal }) => Promise<{ key: string; contentType: string | null }>;
