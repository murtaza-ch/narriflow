import styles from "./cut-artwork.module.css";

function MediaFrame({ portrait = false }: { portrait?: boolean }) {
  return <div className={`${styles.mediaFrame} ${portrait ? styles.portrait : ""}`}>
    <span className={styles.mountains} />
    <span className={styles.sun} />
    <span className={styles.play}>▶</span>
    <span className={styles.scrubber}><i /></span>
  </div>;
}

export function CutArtwork({ paused }: { paused: boolean }) {
  return <div className={styles.scene} data-paused={paused} aria-hidden="true">
    <div className={styles.left}>
      <div className={styles.turntable}>
        <div className={styles.source}>
          <MediaFrame />
          <div className={styles.filmTrack}><i /><i /><i /><i /><i /></div>
          <span className={styles.cutLine} />
        </div>
      </div>
    </div>
    <div className={styles.right}>
      <div className={styles.turntable}>
        <div className={styles.clips}><MediaFrame portrait /><MediaFrame portrait /><MediaFrame portrait /></div>
      </div>
    </div>
  </div>;
}
