import { Button } from "@narriflow/ui/components/button";
import type { TranscriptSnapshot } from "@narriflow/validators";

function formatTimestamp(totalSeconds: number) {
  const safeSeconds = Math.max(0, totalSeconds);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = Math.floor(safeSeconds % 60);

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function TranscriptPanel({
  projectId,
  transcript,
}: {
  projectId: string;
  transcript: TranscriptSnapshot | null;
}) {
  if (!transcript) {
    return (
      <section className="rounded-xl border border-border p-6">
        <h2 className="text-lg font-semibold">Transcript</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          No transcript has been generated yet. Start transcription once ingest
          is ready.
        </p>
      </section>
    );
  }

  const isReady = transcript.status === "completed";

  return (
    <section className="space-y-4 rounded-xl border border-border p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Transcript</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Status: {transcript.status}
            {transcript.languageCode
              ? ` · Language: ${transcript.languageCode}`
              : ""}
            {typeof transcript.speakerCount === "number"
              ? ` · Speakers: ${transcript.speakerCount}`
              : ""}
          </p>
          {transcript.errorCode ? (
            <p className="mt-1 text-sm text-destructive">
              Last transcription error: {transcript.errorCode}
            </p>
          ) : null}
        </div>
        {isReady ? (
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" variant="outline">
              <a
                href={`/api/projects/${projectId}/transcript/export?format=txt`}
              >
                TXT
              </a>
            </Button>
            <Button asChild size="sm" variant="outline">
              <a
                href={`/api/projects/${projectId}/transcript/export?format=srt`}
              >
                SRT
              </a>
            </Button>
            <Button asChild size="sm" variant="outline">
              <a
                href={`/api/projects/${projectId}/transcript/export?format=vtt`}
              >
                VTT
              </a>
            </Button>
          </div>
        ) : null}
      </div>

      {!isReady ? (
        <p className="text-sm text-muted-foreground">
          Narriflow is preparing a read-only transcript with speaker labels and
          export-ready subtitles.
        </p>
      ) : transcript.utterances.length > 0 ? (
        <div className="max-h-[32rem] space-y-3 overflow-y-auto pr-2">
          {transcript.utterances.map((utterance) => (
            <article
              key={`${utterance.index}-${utterance.startSec}`}
              className="rounded-lg border border-border p-4"
            >
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">
                  {utterance.speakerLabel}
                </span>
                <span>{formatTimestamp(utterance.startSec)}</span>
                <span>-</span>
                <span>{formatTimestamp(utterance.endSec)}</span>
              </div>
              <p className="mt-2 text-sm leading-6">{utterance.text}</p>
            </article>
          ))}
        </div>
      ) : (
        <pre className="max-h-[32rem] overflow-auto rounded-lg bg-muted/40 p-4 text-sm leading-6 whitespace-pre-wrap">
          {transcript.text ??
            "Transcript completed, but no utterances were returned."}
        </pre>
      )}
    </section>
  );
}
