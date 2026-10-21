import type { CSSProperties, ReactNode } from "react";

function Card({ title, body, tag, children }: { title: string; body: string; tag?: string; children: ReactNode }) {
  return (
    <article className="lx-feat" data-reveal="">
      <div className="lx-feat__art" aria-hidden="true">
        {children}
      </div>
      <h3>
        {title}
        {tag ? <span className="lx-tag">{tag}</span> : null}
      </h3>
      <p>{body}</p>
    </article>
  );
}

const LANGUAGES = ["Spanish", "French", "German", "Portuguese", "Hindi", "Japanese"];

function DubArt() {
  return (
    <div className="lx-art-dub">
      <div className="lx-art-dub__wave">
        {Array.from({ length: 28 }, (_, i) => (
          <i key={i} style={{ "--i": i } as CSSProperties} />
        ))}
      </div>
      <div className="lx-art-dub__lang">
        <span>English</span>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
        <span className="lx-art-dub__ticker">
          <span>
            {[...LANGUAGES, LANGUAGES[0]].map((language, i) => (
              <b key={`${language}-${i}`}>{language}</b>
            ))}
          </span>
        </span>
      </div>
    </div>
  );
}

function SuiteArt() {
  return (
    <div className="lx-art-suite">
      <div className="lx-art-suite__tabs">
        <span>Blog</span>
        <span>X thread</span>
        <span>LinkedIn</span>
        <span>Show notes</span>
      </div>
      <div className="lx-art-suite__doc">
        {[0.92, 0.78, 0.86, 0.6, 0.9, 0.7].map((width, i) => (
          <i key={i} style={{ "--w": width, "--i": i } as CSSProperties} />
        ))}
      </div>
    </div>
  );
}

function AutopilotArt() {
  return (
    <div className="lx-art-auto">
      <div className="lx-art-auto__node">
        <span className="lx-art-auto__icon">RSS</span>
        <b>New episode</b>
        <em>Episode 113 published</em>
      </div>
      <div className="lx-art-auto__pipe">
        <i />
      </div>
      <div className="lx-art-auto__node">
        <span className="lx-art-auto__icon lx-art-auto__icon--clip">✦</span>
        <b>Clipping</b>
        <em>Moments, captions, framing</em>
      </div>
      <div className="lx-art-auto__pipe">
        <i />
      </div>
      <div className="lx-art-auto__node">
        <span className="lx-art-auto__icon lx-art-auto__icon--ready">✓</span>
        <b>Ready for review</b>
        <em>Clips waiting in your project</em>
      </div>
    </div>
  );
}

function ApiArt() {
  return (
    <div className="lx-art-api">
      <div className="lx-art-api__bar">
        <i />
        <i />
        <i />
        <span>finalize.sh</span>
      </div>
      <pre>
        <code>
          <span className="t-dim">curl -X POST </span>
          <span className="t-str">&quot;$NARRIFLOW/api/v1/uploads/$ID/finalize&quot;</span>
          {" \\\n  "}
          <span className="t-dim">-H </span>
          <span className="t-str">&quot;Authorization: Bearer $NARRIFLOW_API_KEY&quot;</span>
          {" \\\n  "}
          <span className="t-dim">-d </span>
          <span className="t-key">{`'{"callback":{"url":"https://hooks.example.com"}}'`}</span>
        </code>
      </pre>
      <div className="lx-art-api__clients">
        {["Claude", "ChatGPT", "Codex", "n8n"].map((client) => (
          <span key={client}>{client}</span>
        ))}
      </div>
    </div>
  );
}

/** The rest of the workflow, one card per capability. */
export function Features() {
  return (
    <section className="lx-features lx-container" aria-labelledby="features-title">
      <div className="lx-features__head" data-reveal="">
        <p className="lx-eyebrow">After the cut</p>
        <h2 id="features-title" className="lx-serif lx-h2">
          One recording,
          <br />
          <span className="lx-dim">every format.</span>
        </h2>
      </div>
      <div className="lx-feats">
        <Card title="Voiceover dubbing" tag="Pro" body="Give a clip a second life in another language without re-recording it.">
          <DubArt />
        </Card>
        <Card title="Repurpose the transcript" body="Turn an episode into a blog post, an X thread, a LinkedIn post and show notes.">
          <SuiteArt />
        </Card>
        <Card title="Autopilot for your feed" body="New podcast episodes are clipped as they arrive and wait for your review.">
          <AutopilotArt />
        </Card>
        <Card title="API and AI assistants" tag="Business" body="Scoped API keys with signed callbacks, plus a connector for Claude, ChatGPT and Codex.">
          <ApiArt />
        </Card>
      </div>
    </section>
  );
}
