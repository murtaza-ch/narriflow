"use client";

import { useState, type CSSProperties, type PointerEvent } from "react";
import Link from "next/link";
import { Pause, Play, Rss, Upload } from "lucide-react";
import { HeroPasteLinkField } from "./dashboard-client";
import styles from "./hero-experience.module.css";
import { CutArtwork } from "./cut-artwork";

export function tiltScene(event: PointerEvent<HTMLElement>) {
  if (event.pointerType !== "mouse" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const rect = event.currentTarget.getBoundingClientRect();
  event.currentTarget.style.setProperty("--rx", `${(0.5 - (event.clientY - rect.top) / rect.height) * 9}deg`);
  event.currentTarget.style.setProperty("--ry", `${((event.clientX - rect.left) / rect.width - 0.5) * 14}deg`);
}
export function resetScene(event: PointerEvent<HTMLElement>) {
  event.currentTarget.style.setProperty("--rx", "0deg");
  event.currentTarget.style.setProperty("--ry", "0deg");
}

function Wave({ count = 25 }: { count?: number }) {
  return <span className={styles.wave}>{Array.from({ length: count }, (_, i) => <i key={`bar-${i}`} style={{ "--h": `${12 + Math.sin(i * 1.7) ** 2 * 30}px`, "--delay": `${i * -0.09}s` } as CSSProperties} />)}</span>;
}

export function ToolArtwork({ kind }: { kind: string }) {
  return <div className={styles.toolArt} aria-hidden="true">
    {kind === "clips" && <div className={styles.miniClips}><span /><span><i>▶</i><b>THE GOOD PART.</b></span><span /></div>}
    {kind === "captions" && <div className={styles.captionArt}><span>Words with</span><strong>main character</strong><span>energy.<i /></span></div>}
    {kind === "repurpose" && <div className={styles.paperArt}><span><i /><i /><i /></span><span><b>A fresh take.</b><i /><i /><i /></span><em>↗</em></div>}
    {kind === "dubbing" && <div className={styles.dubArt}><span>Hello.</span><Wave count={17} /><strong>Hola!</strong></div>}
  </div>;
}

export function HeroExperience({ canCreate }: { canCreate: boolean }) {
  const [paused, setPaused] = useState(false);
  return (
    <section className={styles.experience} data-paused={paused}>
      <div className={styles.centeredHero} onPointerMove={paused ? undefined : tiltScene} onPointerLeave={resetScene}>
        <CutArtwork paused={paused} />
        <div className={styles.centerContent}>
          <h1>Long video. <span>Short-form magic.</span></h1>
          <p className={styles.description}>Find your best moments. Turn them into captioned clips, ready to share.</p>
          {canCreate ? (
            <div className={styles.importArea}>
              <HeroPasteLinkField />
              <div className={styles.importLinks}>
                <Link href="/upload"><Upload size={15} />Upload a file</Link>
                <Link href="/upload?source=rss"><Rss size={15} />Import a podcast</Link>
              </div>
            </div>
          ) : <p className={styles.description}>This workspace is read-only for your current role or subscription state.</p>}
        </div>
        <button className={styles.motionToggle} type="button" aria-label={paused ? "Play hero animation" : "Pause hero animation"} onClick={() => setPaused(!paused)}>
          {paused ? <Play size={12} /> : <Pause size={12} />}
        </button>
      </div>
    </section>
  );
}
