"use client";

// Throwaway design study. Every workflow and account below is an in-memory fixture.
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  AudioLines,
  Bell,
  Bot,
  Captions,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clapperboard,
  Clock3,
  Copy,
  FileText,
  Film,
  FolderOpen,
  Globe2,
  Grid2X2,
  House,
  Languages,
  LayoutGrid,
  Link2,
  List,
  LoaderCircle,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  Search,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Star,
  Trash2,
  Upload,
  X,
  Youtube,
  CalendarDays,
  Palette,
  Plug,
  type LucideIcon,
} from "lucide-react";

type View =
  | "home"
  | "projects"
  | "project"
  | "processing"
  | "kit"
  | "exports"
  | "calendar"
  | "autopilot"
  | "brand"
  | "integrations";
type Modal =
  | "import"
  | "preview"
  | "export"
  | "publish"
  | "share"
  | "rename"
  | "delete"
  | "search"
  | "workspace"
  | "help"
  | "settings"
  | null;
type Clip = {
  id: number;
  title: string;
  score: number;
  duration: string;
  start: string;
  quote: string;
  reason: string;
  caption: string;
  favorite: boolean;
};
const thumbnail = "https://i.ytimg.com/vi/4nC_YTAVmls/maxresdefault.jpg";
const photo = (id: string) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=900&q=85`;
const photos = [
  thumbnail,
  photo("photo-1598488035139-bdbb2231ce04"),
  photo("photo-1497366754035-f200968a6e72"),
  photo("photo-1516321318423-f06f85e504b3"),
];
const seedClips: [Clip, ...Clip[]] = [
  {
    id: 1,
    title: "The smallest change could be the biggest upgrade",
    score: 96,
    duration: "0:42",
    start: "01:24",
    quote:
      "Sometimes the most interesting part of a new product isn't the feature everyone is talking about. It's the small change that quietly makes everything else better. That's the part you only notice when you start using it every day.",
    reason:
      "A clear, unexpected opening creates a curiosity gap. The everyday example makes a technical story easy to follow.",
    caption: "THE SMALL THINGS\nCHANGE EVERYTHING",
    favorite: false,
  },
  {
    id: 2,
    title: "What actually matters when you upgrade",
    score: 92,
    duration: "0:58",
    start: "03:10",
    quote:
      "Forget the spec sheet for a second. Think about the thing you do a hundred times a day. Does it feel faster? Is it easier? That's the question worth asking before you decide to upgrade.",
    reason:
      "Challenges a familiar assumption and gives viewers a practical way to make a decision.",
    caption: "FORGET THE\nSPEC SHEET",
    favorite: false,
  },
  {
    id: 3,
    title: "A better camera is only half the story",
    score: 88,
    duration: "0:36",
    start: "05:42",
    quote:
      "A camera can capture more detail, but the real difference is what happens after you press the shutter. Software has become just as important as the lens in your pocket.",
    reason: "A short explanation with a strong contrast and an easy takeaway for a broad audience.",
    caption: "ONLY HALF\nTHE STORY",
    favorite: false,
  },
  {
    id: 4,
    title: "The feature nobody saw coming",
    score: 85,
    duration: "0:49",
    start: "07:18",
    quote:
      "Every year there's one detail that gets buried in the announcement. And sometimes that detail ends up being the thing that changes how we use the whole device.",
    reason: "The opening promises a discovery and keeps the viewer curious through the payoff.",
    caption: "NOBODY SAW\nTHIS COMING",
    favorite: false,
  },
];
const nav: { view: View; label: string; icon: LucideIcon }[] = [
  { view: "home", label: "Home", icon: House },
  { view: "projects", label: "Projects", icon: FolderOpen },
  { view: "exports", label: "Exports", icon: ArrowDownToLine },
  { view: "calendar", label: "Calendar", icon: CalendarDays },
  { view: "autopilot", label: "Autopilot", icon: Bot },
  { view: "brand", label: "Brand kit", icon: Palette },
  { view: "integrations", label: "Integrations", icon: Plug },
];
const validViews: View[] = [...nav.map((n) => n.view), "project", "processing", "kit"];
const labels: Record<View, string> = {
  home: "Home",
  projects: "Projects",
  project: "Project",
  processing: "Processing",
  kit: "UI kit",
  exports: "Exports",
  calendar: "Calendar",
  autopilot: "Autopilot",
  brand: "Brand kit",
  integrations: "Integrations",
};

function IconButton({
  icon: Icon,
  label,
  onClick,
  active = false,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      className={`nf-icon-button ${active ? "active" : ""}`}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <Icon size={18} />
    </button>
  );
}
function Button({
  children,
  onClick,
  primary = false,
  disabled = false,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  primary?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={`nf-button ${primary ? "primary" : ""} ${className}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
function Pill({ children, tone = "neutral" }: { children: ReactNode; tone?: string }) {
  return <span className={`nf-pill ${tone}`}>{children}</span>;
}
function Empty({
  icon: Icon = FolderOpen,
  title,
  text,
  children,
}: {
  icon?: LucideIcon;
  title: string;
  text: string;
  children?: ReactNode;
}) {
  return (
    <div className="nf-empty">
      <span className="nf-empty-icon">
        <Icon size={25} />
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
      {children}
    </div>
  );
}
function Toggle({
  label,
  text,
  checked,
  onChange,
}: {
  label: string;
  text?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="nf-toggle-row">
      <span>
        <strong>{label}</strong>
        {text && <small>{text}</small>}
      </span>
      <input
        type="checkbox"
        role="switch"
        aria-checked={checked}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="nf-toggle" />
    </label>
  );
}
function Segments({
  values,
  value,
  onChange,
}: {
  values: string[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="nf-segments">
      {values.map((item) => (
        <button
          type="button"
          key={item}
          aria-pressed={value === item}
          className={value === item ? "active" : ""}
          onClick={() => onChange(item)}
        >
          {item}
        </button>
      ))}
    </div>
  );
}
function SampleMedia({
  clip,
  compact = false,
  onPlay,
}: {
  clip: Clip;
  compact?: boolean;
  onPlay?: () => void;
}) {
  return (
    <button
      type="button"
      className={`nf-clip-media ${compact ? "compact" : ""}`}
      onClick={onPlay}
      aria-label={`Preview ${clip.title}`}
      style={{ backgroundImage: `url(${thumbnail})` }}
    >
      <span className="nf-media-shade" />
      <span className="nf-media-top">
        <span>9:16</span>
        <span>HD</span>
      </span>
      <span className="nf-media-play">
        <Play size={24} fill="currentColor" />
      </span>
      <span className="nf-caption-overlay">
        {clip.caption.split("\n").map((line, i) => (
          <span key={line} className={i === 1 ? "accent" : ""}>
            {line}
          </span>
        ))}
      </span>
      <span className="nf-media-bottom">
        <AudioLines size={14} />
        {clip.duration}
      </span>
    </button>
  );
}

export default function DashboardPrototype({ initialView }: { initialView?: string }) {
  const [view, setView] = useState<View>(
    validViews.includes(initialView as View) ? (initialView as View) : "home",
  );
  const [collapsed, setCollapsed] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [toast, setToast] = useState("");
  const [link, setLink] = useState("");
  const [importStep, setImportStep] = useState(0);
  const [importError, setImportError] = useState("");
  const [importMethod, setImportMethod] = useState("Link");
  const [fileName, setFileName] = useState("");
  const [length, setLength] = useState("Auto");
  const [ratio, setRatio] = useState("9:16");
  const [preset, setPreset] = useState("Studio");
  const [autoHook, setAutoHook] = useState(true);
  const [autoRender, setAutoRender] = useState(true);
  const [advanced, setAdvanced] = useState(false);
  const [progress, setProgress] = useState(0);
  const [processingActive, setProcessingActive] = useState(initialView === "processing");
  const [scenario, setScenario] = useState("Populated");
  const [clips, setClips] = useState<Clip[]>(seedClips);
  const [selected, setSelected] = useState<number[]>([]);
  const [activeClipId, setActiveClipId] = useState(1);
  const [filter, setFilter] = useState("All clips");
  const [sort, setSort] = useState("Highest score");
  const [projectTab, setProjectTab] = useState("Clips");
  const [projectTitle, setProjectTitle] = useState("Here's Apple's iPhone event... early.");
  const [projectNames, setProjectNames] = useState<Record<string, string>>({});
  const [projectSearch, setProjectSearch] = useState("");
  const [listMode, setListMode] = useState(false);
  const [menu, setMenu] = useState<number | null>(null);
  const [rename, setRename] = useState("");
  const [search, setSearch] = useState("");
  const [quality, setQuality] = useState("1080p");
  const [exportFormat, setExportFormat] = useState("Video");
  const [exported, setExported] = useState(false);
  const [hasExport, setHasExport] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [publishMode, setPublishMode] = useState("Schedule");
  const [publishChannel, setPublishChannel] = useState("Instagram");
  const [publishDate, setPublishDate] = useState("2026-09-08");
  const [publishTime, setPublishTime] = useState("18:00");
  const [publishCopy, setPublishCopy] = useState(
    "The small changes are the ones that stay with you. What's your take? #technology #creators",
  );
  const [scheduled, setScheduled] = useState(false);
  const [connected, setConnected] = useState(true);
  const [kitTab, setKitTab] = useState("Foundations");
  const [workspaceName, setWorkspaceName] = useState("Murtaza's workspace");
  const [kitSwitch, setKitSwitch] = useState(true);
  const [shareCopied, setShareCopied] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeClip = clips.find((c) => c.id === activeClipId) ?? seedClips[0];
  const [actionCount, setActionCount] = useState(1);

  function navigate(next: View) {
    if (next === "processing") setProcessingActive(true);
    setView(next);
    setMobileNav(false);
    setMenu(null);
    window.history.pushState(
      {},
      "",
      `/prototype/dashboard${next === "home" ? "" : `?view=${next}`}`,
    );
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  function notify(message: string) {
    setToast(message);
  }
  function openImport(method = "Link") {
    setImportStep(0);
    setImportError("");
    setImportMethod(method);
    setModal("import");
  }
  function openAction(next: Modal, id?: number) {
    if (id !== undefined) setActiveClipId(id);
    setActionCount(id !== undefined ? 1 : Math.max(1, selected.length));
    setMenu(null);
    setExported(false);
    setShareCopied(false);
    setModal(next);
  }
  function openProject(title = "Here's Apple's iPhone event... early.") {
    setProjectTitle(title);
    setProjectTab("Clips");
    setFilter("All clips");
    setScenario("Populated");
    navigate("project");
  }
  function prepareImport() {
    if (importMethod === "Upload") {
      if (!fileName) {
        setImportError("Choose a video or audio file first.");
        return;
      }
    } else {
      try {
        const url = new URL(link);
        if (!["https:", "http:"].includes(url.protocol)) throw new Error();
      } catch {
        setImportError("Enter a complete video link, starting with https://.");
        return;
      }
    }
    if (scenario === "Import failed" && importMethod !== "Upload") {
      setImportError(
        "We couldn't access this video. Check that it's public, try another link, or upload the file.",
      );
      return;
    }
    setImportError("");
    setImportStep(1);
  }
  function generate() {
    setModal(null);
    setProgress(0);
    setScenario("Populated");
    navigate("processing");
  }
  function runExport() {
    setExportBusy(true);
    timer.current = setTimeout(() => {
      setExportBusy(false);
      setExported(true);
      setHasExport(true);
      notify(`${actionCount} demo ${actionCount === 1 ? "export is" : "exports are"} ready`);
    }, 1500);
  }
  function downloadSample() {
    const contents =
      exportFormat === "Subtitles"
        ? `1\n00:00:00,000 --> 00:00:04,000\n${activeClip.quote}\n`
        : `NARRIFLOW Prototype\n\n${activeClip.title}\n${activeClip.quote}\n\nThis is a sample transcript, not a rendered video.`;
    const url = URL.createObjectURL(new Blob([contents], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download =
      exportFormat === "Subtitles" ? "narriflow-sample.srt" : "narriflow-sample-transcript.txt";
    a.click();
    URL.revokeObjectURL(url);
    notify("Sample file downloaded");
  }
  useEffect(() => {
    const onBack = () => {
      const next = new URLSearchParams(window.location.search).get("view") as View;
      setView(validViews.includes(next) ? next : "home");
    };
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        setModal("search");
      }
      if (event.key === "Escape") {
        setMenu(null);
        setMobileNav(false);
      }
    };
    window.addEventListener("popstate", onBack);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("popstate", onBack);
      window.removeEventListener("keydown", onKey);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timeout = setTimeout(() => setToast(""), 3500);
    return () => clearTimeout(timeout);
  }, [toast]);
  useEffect(() => {
    if (modal && !dialog.current?.open) dialog.current?.showModal();
    if (!modal && dialog.current?.open) dialog.current.close();
  }, [modal]);
  useEffect(() => {
    if (!processingActive || progress >= 100 || scenario === "Import failed") return;
    const tick = setInterval(() => setProgress((value) => Math.min(100, value + 4)), 400);
    return () => clearInterval(tick);
  }, [processingActive, progress, scenario]);

  const projectCards = [
    {
      title:
        projectNames["Here's Apple's iPhone event... early."] ??
        "Here's Apple's iPhone event... early.",
      image: photos[0],
      clips: "4 clips",
      date: "Just now",
      time: "9:56",
      kind: "YouTube",
      state: "Ready",
    },
    {
      title: projectNames["Studio session · Episode 12"] ?? "Studio session · Episode 12",
      image: photos[1],
      clips: "12 clips",
      date: "Yesterday",
      time: "48:32",
      kind: "Upload",
      state: "Ready",
    },
    {
      title: projectNames["Product team conversation"] ?? "Product team conversation",
      image: photos[2],
      clips: "8 clips",
      date: "Sep 5",
      time: "32:18",
      kind: "Upload",
      state: "Ready",
    },
    {
      title: "A different way to think about creativity",
      image: photos[3],
      clips: "Finding moments",
      date: "Sep 4",
      time: "24:09",
      kind: "YouTube",
      state: "Processing",
    },
  ];
  const filteredCards = projectCards.filter((card) =>
    card.title.toLowerCase().includes(projectSearch.toLowerCase()),
  );
  const visibleClips = [...clips]
    .filter((clip) => filter !== "Favorites" || clip.favorite)
    .sort((a, b) =>
      sort === "Earliest first"
        ? a.start.localeCompare(b.start)
        : sort === "Shortest first"
          ? a.duration.localeCompare(b.duration)
          : b.score - a.score,
    );
  function toggleClip(id: number) {
    setSelected((value) => (value.includes(id) ? value.filter((x) => x !== id) : [...value, id]));
  }
  function toggleFavorite(id: number) {
    setClips((value) => value.map((c) => (c.id === id ? { ...c, favorite: !c.favorite } : c)));
  }

  function projectGrid() {
    if (scenario === "Loading")
      return (
        <div className="nf-project-grid">
          {[1, 2, 3].map((i) => (
            <div key={i} className="nf-skeleton nf-skeleton-card" />
          ))}
        </div>
      );
    if (scenario === "Empty" || filteredCards.length === 0)
      return (
        <Empty
          title={projectSearch ? "No matching projects" : "Your first story starts here"}
          text={
            projectSearch
              ? "Try a different title or clear your search."
              : "Import a video. We'll help you find the moments worth sharing."
          }
        >
          <Button primary onClick={() => (projectSearch ? setProjectSearch("") : openImport())}>
            {projectSearch ? "Clear search" : "Import a video"}
            <ArrowRight size={15} />
          </Button>
        </Empty>
      );
    return (
      <div className={`nf-project-grid ${listMode ? "list" : ""}`}>
        {filteredCards.slice(0, view === "home" ? 3 : 4).map((card) => (
          <article className="nf-project-card" key={card.title}>
            <button
              type="button"
              className="nf-project-cover"
              onClick={() => {
                if (card.state === "Processing") {
                  setProgress(36);
                  navigate("processing");
                } else openProject(card.title);
              }}
              aria-label={`Open ${card.title}`}
            >
              {/* Standard images keep this isolated prototype independent of image-host configuration. */}
              <img src={card.image} alt="" loading="lazy" />
              <span className="nf-cover-shade" />
              <span className="nf-duration">{card.time}</span>
              <span className="nf-cover-play">
                <Play size={20} fill="currentColor" />
              </span>
              <span className="nf-source-icon">
                {card.kind === "YouTube" ? <Youtube size={16} /> : <Upload size={14} />}
              </span>
            </button>
            <div className="nf-project-meta">
              <button type="button" onClick={() => openProject(card.title)}>
                {card.title}
              </button>
              <p>
                <span>{card.date}</span>
                <span className="nf-dot" />
                <span className={card.state === "Processing" ? "nf-blue" : ""}>{card.clips}</span>
              </p>
            </div>
            <IconButton
              icon={MoreHorizontal}
              label={`Options for ${card.title}`}
              onClick={() => {
                setProjectTitle(card.title);
                setRename(card.title);
                setActiveClipId(0);
                setModal("rename");
              }}
            />
          </article>
        ))}
      </div>
    );
  }

  return (
    <div className={`nf-prototype ${collapsed ? "is-collapsed" : ""}`}>
      {mobileNav && (
        <button
          type="button"
          aria-label="Close navigation"
          className="nf-nav-scrim"
          onClick={() => setMobileNav(false)}
        />
      )}
      <aside className={`nf-sidebar ${mobileNav ? "mobile-open" : ""}`}>
        <div className="nf-brand-row">
          <button
            type="button"
            className="nf-brand"
            onClick={() => navigate("home")}
            aria-label="Narriflow home"
          >
            <span className="nf-brand-mark">
              <i />
              <i />
              <i />
            </span>
            <span className="nf-nav-label">
              narriflow<span className="nf-brand-period">.</span>
            </span>
          </button>
          <IconButton
            icon={collapsed ? PanelLeftOpen : PanelLeftClose}
            label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => setCollapsed(!collapsed)}
          />
        </div>
        <button
          type="button"
          className="nf-workspace"
          onClick={() => setModal("workspace")}
          title="Switch workspace"
        >
          <span className="nf-avatar">M</span>
          <span className="nf-nav-label">
            <strong>{workspaceName}</strong>
            <small>Creator workspace</small>
          </span>
          <ChevronDown size={14} className="nf-nav-label" />
        </button>
        <button
          type="button"
          className="nf-new-project"
          title="New project"
          onClick={() => openImport()}
        >
          <Plus size={18} />
          <span className="nf-nav-label">New project</span>
        </button>
        <nav aria-label="Main navigation">
          {nav.map(({ view: next, label, icon: Icon }, index) => (
            <div key={next}>
              {index === 4 && <div className="nf-nav-section nf-nav-label">Workspace</div>}
              <button
                type="button"
                title={label}
                aria-current={view === next ? "page" : undefined}
                className={`nf-nav-item ${view === next || (next === "projects" && ["project", "processing"].includes(view)) ? "active" : ""}`}
                onClick={() => navigate(next)}
              >
                <Icon size={18} />
                <span className="nf-nav-label">{label}</span>
                {next === "projects" && <span className="nf-nav-count nf-nav-label">4</span>}
                {next === "autopilot" && <span className="nf-mini-new nf-nav-label">NEW</span>}
              </button>
            </div>
          ))}
        </nav>
        <div className="nf-sidebar-bottom">
          <button
            type="button"
            className={`nf-nav-item ${view === "kit" ? "active" : ""}`}
            title="UI kit"
            onClick={() => navigate("kit")}
          >
            <Grid2X2 size={18} />
            <span className="nf-nav-label">
              UI kit <span className="nf-muted">↗</span>
            </span>
          </button>
          <button
            type="button"
            className="nf-nav-item"
            title="Help & shortcuts"
            onClick={() => setModal("help")}
          >
            <CircleHelp size={18} />
            <span className="nf-nav-label">Help & shortcuts</span>
          </button>
          <div className="nf-usage nf-nav-label">
            <div>
              <span>Monthly minutes</span>
              <strong>
                120 <span>/ 300</span>
              </strong>
            </div>
            <div className="nf-progress-line">
              <i style={{ width: "40%" }} />
            </div>
            <small>Renews October 1</small>
          </div>
          <button
            type="button"
            className="nf-account"
            title="Workspace settings"
            onClick={() => setModal("settings")}
          >
            <span className="nf-avatar person">MA</span>
            <span className="nf-nav-label">
              <strong>Murtaza Asghar</strong>
              <small>Creator plan</small>
            </span>
            <MoreHorizontal size={17} className="nf-nav-label" />
          </button>
        </div>
      </aside>
      <div className="nf-main-shell">
        <header className="nf-topbar">
          <div className="nf-topbar-left">
            <span className="nf-mobile-toggle">
              <IconButton
                icon={PanelLeftOpen}
                label="Open navigation"
                onClick={() => setMobileNav(true)}
              />
            </span>
            <span>{labels[view]}</span>
            {view === "project" && (
              <>
                <ChevronRight size={14} />
                <span className="nf-breadcrumb-title">{projectTitle}</span>
              </>
            )}
          </div>
          <div className="nf-topbar-right">
            <button
              type="button"
              className="nf-search-trigger"
              aria-label="Search anything"
              onClick={() => setModal("search")}
            >
              <Search size={16} />
              <span>Search anything</span>
              <kbd>⌘ K</kbd>
            </button>
            <span className="nf-topbar-divider" />
            <IconButton
              icon={Bell}
              label="Notifications"
              onClick={() =>
                notify("You're all caught up. New exports and processing updates appear here.")
              }
            />
            <span className="nf-avatar small">M</span>
          </div>
        </header>
        <main className={`nf-content ${view === "project" ? "project-view" : ""}`}>
          {(view === "home" || view === "projects") && (
            <>
              {view === "home" ? (
                <>
                  <section className="nf-hero">
                    <h1>Create clips</h1>
                    <p>Import a video to find, edit, and publish short clips.</p>
                    <form
                      className="nf-import-composer"
                      onSubmit={(e) => {
                        e.preventDefault();
                        openImport();
                      }}
                    >
                      <Link2 size={20} />
                      <input
                        aria-label="Video link"
                        placeholder="Paste a YouTube or video link..."
                        value={link}
                        onChange={(e) => setLink(e.target.value)}
                      />
                      <button type="submit">
                        Get clips
                        <ArrowRight size={17} />
                      </button>
                    </form>
                    <div className="nf-import-alternatives">
                      <button type="button" onClick={() => openImport("Upload")}>
                        <Upload size={14} />
                        Upload a file
                      </button>
                      <span>or</span>
                      <button type="button" onClick={() => openImport("RSS feed")}>
                        <AudioLines size={14} />
                        Import a podcast
                      </button>
                      <span className="nf-import-hint">MP4, MOV, WebM, MP3 · up to 5 GB</span>
                    </div>
                  </section>
                  <section className="nf-tools" aria-label="Creation tools">
                    {[
                      {
                        icon: Clapperboard,
                        name: "AI clips",
                        text: "Extract short clips",
                        color: "blue",
                      },
                      {
                        icon: Captions,
                        name: "Captions",
                        text: "Add and style subtitles",
                        color: "yellow",
                      },
                      {
                        icon: FileText,
                        name: "Repurpose",
                        text: "Create posts and summaries",
                        color: "mint",
                      },
                      {
                        icon: Languages,
                        name: "Dubbing",
                        text: "Translate voice and captions",
                        color: "peach",
                      },
                    ].map(({ icon: Icon, name, text, color }) => (
                      <button
                        type="button"
                        className="nf-tool-card"
                        key={name}
                        onClick={() => {
                          if (name === "AI clips" || name === "Captions") {
                            openImport();
                          } else {
                            openProject();
                            setProjectTab(name);
                          }
                        }}
                      >
                        <span className={`nf-tool-icon ${color}`}>
                          <Icon size={23} />
                        </span>
                        <span>
                          <strong>{name}</strong>
                          <small>{text}</small>
                        </span>
                        <ArrowUpRight />
                      </button>
                    ))}
                  </section>
                </>
              ) : (
                <div className="nf-page-heading">
                  <div>
                    <div className="nf-eyebrow">YOUR LIBRARY</div>
                    <h1>
                      All projects<span className="nf-heading-count">4</span>
                    </h1>
                    <p>Every video. Every possibility.</p>
                  </div>
                  <Button primary onClick={() => openImport()}>
                    <Plus size={16} />
                    New project
                  </Button>
                </div>
              )}
              <section className="nf-projects-section">
                <div className="nf-section-heading">
                  <div>
                    <h2>{view === "home" ? "Recent projects" : "Projects"}</h2>
                  </div>
                  <div className="nf-inline">
                    {view === "home" ? (
                      <button
                        type="button"
                        className="nf-text-button"
                        onClick={() => navigate("projects")}
                      >
                        View all projects
                        <ArrowRight size={15} />
                      </button>
                    ) : (
                      <label className="nf-inline-search">
                        <Search size={15} />
                        <input
                          aria-label="Search projects"
                          placeholder="Search projects"
                          value={projectSearch}
                          onChange={(e) => setProjectSearch(e.target.value)}
                        />
                      </label>
                    )}
                    <div className="nf-view-toggle">
                      <IconButton
                        icon={LayoutGrid}
                        label="Grid view"
                        active={!listMode}
                        onClick={() => setListMode(false)}
                      />
                      <IconButton
                        icon={List}
                        label="List view"
                        active={listMode}
                        onClick={() => setListMode(true)}
                      />
                    </div>
                  </div>
                </div>
                {projectGrid()}
              </section>
              {view === "home" && (
                <section className="nf-bottom-note">
                  <span className="nf-note-icon">
                    <Bot size={23} />
                  </span>
                  <div>
                    <h3>Channel automation</h3>
                    <p>Connect a channel and turn new episodes into clips automatically.</p>
                  </div>
                  <button
                    type="button"
                    className="nf-text-button"
                    onClick={() => navigate("autopilot")}
                  >
                    Set up Autopilot
                    <ArrowRight size={16} />
                  </button>
                </section>
              )}
            </>
          )}
          {view === "processing" && (
            <section className="nf-processing">
              <button type="button" className="nf-text-button" onClick={() => navigate("projects")}>
                <ArrowLeft size={15} />
                Back to projects
              </button>
              <div className="nf-processing-card">
                <div className="nf-processing-art">
                  <img src={thumbnail} alt="Source video thumbnail" />
                  <span className="nf-processing-orbit">
                    {progress === 100 ? <Check size={30} /> : <AudioLines size={30} />}
                  </span>
                </div>
                <Pill tone={progress === 100 ? "green" : "blue"}>
                  {progress === 100 ? "Ready to review" : "Working on your video"}
                </Pill>
                <h1>
                  {scenario === "Import failed"
                    ? "We couldn't import this video"
                    : progress === 100
                      ? "Your best moments are ready."
                      : "Finding the moments that matter."}
                </h1>
                <p>
                  {scenario === "Import failed"
                    ? "Check that the video is public, or upload a local copy."
                    : progress === 100
                      ? "4 clips, ranked and ready for your finishing touches."
                      : "You can leave this page. We'll keep working in the background."}
                </p>
                <div className="nf-processing-source">
                  <Youtube size={17} />
                  <span>{projectTitle}</span>
                  <span>9:56</span>
                </div>
                <div className="nf-processing-steps">
                  {[
                    "Importing your video",
                    "Creating the transcript",
                    "Finding the best moments",
                    "Preparing your clips",
                  ].map((step, i) => (
                    <div
                      className={
                        progress >= (i + 1) * 25
                          ? "complete"
                          : Math.floor(progress / 25) === i
                            ? "current"
                            : ""
                      }
                      key={step}
                    >
                      <span>
                        {progress >= (i + 1) * 25 ? (
                          <Check size={15} />
                        ) : Math.floor(progress / 25) === i ? (
                          <LoaderCircle size={15} className="nf-spin" />
                        ) : (
                          i + 1
                        )}
                      </span>
                      {step}
                    </div>
                  ))}
                </div>
                <div className="nf-processing-progress">
                  <div className="nf-progress-line">
                    <i style={{ width: `${progress}%` }} />
                  </div>
                  <span>{progress}%</span>
                </div>
                <Button
                  primary
                  onClick={() =>
                    scenario === "Import failed"
                      ? openImport()
                      : progress === 100
                        ? openProject(projectTitle)
                        : navigate("projects")
                  }
                >
                  {scenario === "Import failed"
                    ? "Try another source"
                    : progress === 100
                      ? "Review 4 clips"
                      : "Continue in the background"}
                  <ArrowRight size={16} />
                </Button>
                {progress < 100 && (
                  <button
                    type="button"
                    className="nf-text-button nf-demo-skip"
                    onClick={() => setProgress(100)}
                  >
                    Skip ahead in demo
                  </button>
                )}
              </div>
            </section>
          )}
          {view === "project" && (
            <>
              <div className="nf-project-heading">
                <div>
                  <button
                    type="button"
                    className="nf-text-button nf-back"
                    onClick={() => navigate("projects")}
                  >
                    <ArrowLeft size={14} />
                    All projects
                  </button>
                  <h1>{projectTitle}</h1>
                  <p>
                    <Youtube size={15} />
                    YouTube
                    <span className="nf-dot" />
                    9:56
                    <span className="nf-dot" />
                    English
                    <span className="nf-dot" />
                    <span>Added just now</span>
                    <Pill tone="green">
                      <Check size={11} />
                      Ready
                    </Pill>
                  </p>
                </div>
                <div className="nf-inline">
                  <Button onClick={() => openAction("share")}>
                    <Link2 size={15} />
                    Share
                  </Button>
                  <IconButton
                    icon={MoreHorizontal}
                    label="Project settings"
                    onClick={() => {
                      setActiveClipId(0);
                      setRename(projectTitle);
                      setModal("rename");
                    }}
                  />
                </div>
              </div>
              <div className="nf-project-tabs" role="tablist" aria-label="Project sections">
                {[
                  "Clips",
                  "Transcript",
                  "Repurpose",
                  "Dubbing",
                  "Review",
                  "Publish",
                  "Analytics",
                  "Activity",
                ].map((t) => (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={projectTab === t}
                    key={t}
                    onClick={() => setProjectTab(t)}
                  >
                    {t}
                    {t === "Clips" && <span>{clips.length}</span>}
                  </button>
                ))}
              </div>
              {projectTab === "Clips" ? (
                <div className="nf-review-layout">
                  <aside className="nf-clip-index">
                    <div className="nf-index-heading">
                      IN THIS PROJECT<span>{clips.length}</span>
                    </div>
                    {clips.map((clip, i) => (
                      <button
                        type="button"
                        key={clip.id}
                        className={activeClipId === clip.id ? "active" : ""}
                        onClick={() => {
                          setActiveClipId(clip.id);
                          document
                            .getElementById(`nf-clip-${clip.id}`)
                            ?.scrollIntoView({ behavior: "smooth", block: "center" });
                        }}
                      >
                        <span
                          className="nf-index-image"
                          style={{ backgroundImage: `url(${thumbnail})` }}
                        >
                          <b>{i + 1}</b>
                        </span>
                        <span>
                          <strong>{clip.title}</strong>
                          <small>
                            {clip.duration}
                            <span>·</span>
                            {clip.score} score
                          </small>
                        </span>
                      </button>
                    ))}
                    <button
                      type="button"
                      className="nf-generate-more"
                      onClick={() => {
                        setImportStep(1);
                        setModal("import");
                      }}
                    >
                      <Plus size={15} />
                      Generate more clips
                    </button>
                    <div className="nf-index-tip">
                      <Sparkles size={16} />
                      <p>
                        Start with your highest-scoring clips. A strong opening makes all the
                        difference.
                      </p>
                    </div>
                  </aside>
                  <section className="nf-clip-feed">
                    <div className="nf-feed-toolbar">
                      <div className="nf-inline">
                        <button
                          type="button"
                          className={filter === "All clips" ? "nf-filter active" : "nf-filter"}
                          onClick={() => setFilter("All clips")}
                        >
                          All clips <span>{clips.length}</span>
                        </button>
                        <button
                          type="button"
                          className={filter === "Favorites" ? "nf-filter active" : "nf-filter"}
                          onClick={() => setFilter("Favorites")}
                        >
                          <Star size={13} />
                          Favorites
                        </button>
                      </div>
                      <label className="nf-sort">
                        <SlidersHorizontal size={14} />
                        <select
                          aria-label="Sort clips"
                          value={sort}
                          onChange={(e) => setSort(e.target.value)}
                        >
                          <option>Highest score</option>
                          <option>Earliest first</option>
                          <option>Shortest first</option>
                        </select>
                      </label>
                    </div>
                    <div className={`nf-batch-bar ${selected.length ? "has-selection" : ""}`}>
                      <label>
                        <input
                          type="checkbox"
                          aria-label="Select all visible clips"
                          checked={
                            visibleClips.length > 0 &&
                            visibleClips.every((c) => selected.includes(c.id))
                          }
                          onChange={(e) =>
                            setSelected(e.target.checked ? visibleClips.map((c) => c.id) : [])
                          }
                        />
                        <span>
                          {selected.length ? `${selected.length} selected` : "Select all"}
                        </span>
                      </label>
                      <div className="nf-inline">
                        <Button disabled={!selected.length} onClick={() => openAction("export")}>
                          <ArrowDownToLine size={14} />
                          Export
                        </Button>
                        <Button disabled={!selected.length} onClick={() => openAction("publish")}>
                          <Send size={14} />
                          Publish
                        </Button>
                        {selected.length > 0 && (
                          <IconButton
                            icon={X}
                            label="Clear selection"
                            onClick={() => setSelected([])}
                          />
                        )}
                      </div>
                    </div>
                    {scenario === "Empty" || !visibleClips.length ? (
                      <Empty
                        icon={filter === "Favorites" ? Star : Film}
                        title={
                          filter === "Favorites" ? "Keep your best clips close" : "No clips yet"
                        }
                        text={
                          filter === "Favorites"
                            ? "Star a clip to add it to your favorites."
                            : "Adjust your settings and find a new set of moments."
                        }
                      >
                        <Button
                          onClick={() =>
                            filter === "Favorites" ? setFilter("All clips") : openImport()
                          }
                        >
                          {filter === "Favorites" ? "See all clips" : "Adjust settings"}
                        </Button>
                      </Empty>
                    ) : scenario === "Loading" ? (
                      [1, 2].map((i) => <div className="nf-skeleton nf-skeleton-result" key={i} />)
                    ) : (
                      visibleClips.map((clip, i) => (
                        <article
                          id={`nf-clip-${clip.id}`}
                          className={`nf-result ${selected.includes(clip.id) ? "selected" : ""}`}
                          key={clip.id}
                        >
                          <div className="nf-result-media">
                            <SampleMedia
                              clip={clip}
                              onPlay={() => openAction("preview", clip.id)}
                            />
                            <div className="nf-result-select">
                              <input
                                type="checkbox"
                                checked={selected.includes(clip.id)}
                                aria-label={`Select ${clip.title}`}
                                onChange={() => toggleClip(clip.id)}
                              />
                            </div>
                            <button
                              type="button"
                              className={`nf-favorite ${clip.favorite ? "active" : ""}`}
                              aria-label={clip.favorite ? "Remove favorite" : "Favorite clip"}
                              aria-pressed={clip.favorite}
                              onClick={() => toggleFavorite(clip.id)}
                            >
                              <Star size={16} fill={clip.favorite ? "currentColor" : "none"} />
                            </button>
                          </div>
                          <div className="nf-result-body">
                            <div className="nf-result-title">
                              <div>
                                <span className="nf-clip-number">
                                  CLIP {String(i + 1).padStart(2, "0")}
                                </span>
                                <h2>{clip.title}</h2>
                              </div>
                              <div className="nf-menu-anchor">
                                <IconButton
                                  icon={MoreHorizontal}
                                  label={`More actions for clip ${i + 1}`}
                                  onClick={() => setMenu(menu === clip.id ? null : clip.id)}
                                />
                                {menu === clip.id && (
                                  <div className="nf-menu">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setRename(clip.title);
                                        openAction("rename", clip.id);
                                      }}
                                    >
                                      <FileText size={14} />
                                      Rename
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setClips([
                                          ...clips,
                                          {
                                            ...clip,
                                            id: Date.now(),
                                            title: `${clip.title} (copy)`,
                                          },
                                        ]);
                                        setMenu(null);
                                        notify("Clip duplicated in demo");
                                      }}
                                    >
                                      <Copy size={14} />
                                      Duplicate
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => openAction("share", clip.id)}
                                    >
                                      <Link2 size={14} />
                                      Share clip
                                    </button>
                                    <hr />
                                    <button
                                      type="button"
                                      className="danger"
                                      onClick={() => openAction("delete", clip.id)}
                                    >
                                      <Trash2 size={14} />
                                      Delete clip
                                    </button>
                                  </div>
                                )}
                              </div>
                            </div>
                            <div className="nf-result-score">
                              <span className="nf-score">
                                <Sparkles size={14} />
                                <strong>{clip.score}</strong>
                                <span>/ 100</span>
                              </span>
                              <span className="nf-score-label">
                                {clip.score > 90 ? "High potential" : "Strong potential"}
                              </span>
                              <span className="nf-result-length">
                                <Clock3 size={13} />
                                {clip.duration}
                              </span>
                            </div>
                            <details className="nf-reason">
                              <summary>
                                <Sparkles size={13} />
                                Why this clip works
                                <ChevronDown size={14} />
                              </summary>
                              <p>{clip.reason}</p>
                            </details>
                            <div className="nf-transcript-excerpt">
                              <button type="button" onClick={() => openAction("preview", clip.id)}>
                                {clip.start}
                              </button>
                              <p>{clip.quote}</p>
                            </div>
                            <div className="nf-result-actions">
                              <Button onClick={() => openAction("preview", clip.id)}>
                                <Clapperboard size={15} />
                                Preview & edit
                              </Button>
                              <div className="nf-inline">
                                <IconButton
                                  icon={ArrowDownToLine}
                                  label={`Export clip ${i + 1}`}
                                  onClick={() => openAction("export", clip.id)}
                                />
                                <Button primary onClick={() => openAction("publish", clip.id)}>
                                  <Send size={14} />
                                  Publish
                                </Button>
                              </div>
                            </div>
                          </div>
                        </article>
                      ))
                    )}
                  </section>
                </div>
              ) : (
                <section className="nf-project-secondary">
                  {projectTab === "Transcript" ? (
                    <>
                      <div className="nf-section-heading">
                        <h2>Full transcript</h2>
                        <Button
                          onClick={() => {
                            setExportFormat("Transcript");
                            openAction("export");
                          }}
                        >
                          <ArrowDownToLine size={14} />
                          Download transcript
                        </Button>
                      </div>
                      <Pill>Sample transcript for design review</Pill>
                      {clips.map((clip) => (
                        <div className="nf-transcript-line" key={clip.id}>
                          <button type="button" onClick={() => openAction("preview", clip.id)}>
                            {clip.start}
                          </button>
                          <div>
                            <strong>Speaker 1</strong>
                            <p>{clip.quote}</p>
                          </div>
                        </div>
                      ))}
                    </>
                  ) : projectTab === "Publish" ? (
                    <Empty
                      icon={Send}
                      title={
                        scheduled ? "Your next post is on the calendar" : "Ready for your audience"
                      }
                      text={
                        scheduled
                          ? `${publishChannel} · ${publishDate} at ${publishTime}`
                          : "Choose a clip, add your caption, and set a time."
                      }
                    >
                      <Button primary onClick={() => openAction("publish")}>
                        Schedule a clip
                        <ArrowRight size={15} />
                      </Button>
                    </Empty>
                  ) : (
                    <>
                      <div className="nf-section-heading">
                        <div>
                          <h2>{projectTab}</h2>
                          <p className="nf-muted">
                            Available from the same project, without crowding clip review.
                          </p>
                        </div>
                        <Pill>Feature preview</Pill>
                      </div>
                      <div className="nf-feature-grid">
                        {(projectTab === "Repurpose"
                          ? ["LinkedIn post", "X thread", "Blog article"]
                          : projectTab === "Dubbing"
                            ? ["Spanish", "French", "German"]
                            : projectTab === "Review"
                              ? ["Needs review", "Approved", "Changes requested"]
                              : projectTab === "Analytics"
                                ? ["Views", "Engagement", "Top clips"]
                                : ["Video imported", "4 clips detected", "Previews ready"]
                        ).map((title, i) => (
                          <div className="nf-feature-tile" key={title}>
                            <span className={`nf-tool-icon ${["blue", "mint", "peach"][i]}`}>
                              {projectTab === "Dubbing" ? (
                                <Languages size={22} />
                              ) : (
                                <FileText size={22} />
                              )}
                            </span>
                            <h3>{title}</h3>
                            <p>
                              {projectTab === "Repurpose"
                                ? "Create a first draft from the strongest ideas in your video."
                                : projectTab === "Dubbing"
                                  ? "Translate the source audio and captions."
                                  : "This feature remains part of Narriflow's project workflow."}
                            </p>
                            <Button
                              onClick={() =>
                                notify(
                                  `${title} is outside the interactive core of this design demo.`,
                                )
                              }
                            >
                              Explore
                              <ArrowRight size={14} />
                            </Button>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </section>
              )}
            </>
          )}
          {view === "kit" && (
            <>
              <div className="nf-page-heading">
                <div>
                  <div className="nf-eyebrow">NARRIFLOW · DESIGN STUDY 01</div>
                  <h1>Interface kit</h1>
                  <p>Shared colors, typography, components, and interaction patterns.</p>
                </div>
                <div className="nf-kit-logo">
                  <span className="nf-brand-mark">
                    <i />
                    <i />
                    <i />
                  </span>
                </div>
              </div>
              <div className="nf-project-tabs">
                {["Foundations", "Components", "Patterns"].map((t) => (
                  <button
                    type="button"
                    className={kitTab === t ? "active" : ""}
                    key={t}
                    onClick={() => setKitTab(t)}
                  >
                    {t}
                  </button>
                ))}
              </div>
              {kitTab === "Foundations" ? (
                <div className="nf-kit-sections">
                  <section>
                    <div className="nf-kit-label">01 / COLOR</div>
                    <h2>Color palette</h2>
                    <p className="nf-muted">
                      Neutral surfaces for navigation and controls. Blue indicates selection; green
                      indicates completion.
                    </p>
                    <div className="nf-swatches">
                      {[
                        ["Canvas", "#101010"],
                        ["Sidebar", "#080808"],
                        ["Dialog", "#0D0D0F"],
                        ["Surface", "#191919"],
                        ["Raised", "#252525"],
                        ["Text", "#F2F2F2"],
                        ["Accent", "#397CFF"],
                        ["Success", "#9BD9AD"],
                      ].map(([name, color]) => (
                        <div key={name}>
                          <span style={{ background: color }} />
                          <strong>{name}</strong>
                          <code>{color}</code>
                        </div>
                      ))}
                    </div>
                  </section>
                  <section>
                    <div className="nf-kit-label">02 / TYPOGRAPHY</div>
                    <div className="nf-type-grid">
                      <div>
                        <h1>Project heading</h1>
                        <p>Geist Sans · Regular & medium</p>
                        <small>
                          Familiar, compact letterforms keep dense product screens readable.
                        </small>
                      </div>
                      <div>
                        <h2>Section heading</h2>
                        <p>
                          The details belong here. Clear language, comfortable spacing, and no
                          competing headlines.
                        </p>
                        <code>01:24 / 09:56 · 1080 × 1920</code>
                      </div>
                    </div>
                  </section>
                  <section>
                    <div className="nf-kit-label">03 / SHAPE & SPACE</div>
                    <div className="nf-shape-grid">
                      {[8, 12, 16, 24].map((r) => (
                        <div key={r}>
                          <span style={{ borderRadius: r }}>{r}</span>
                          <p>
                            {r === 8
                              ? "Controls"
                              : r === 12
                                ? "Cards"
                                : r === 16
                                  ? "Media"
                                  : "Dialogs"}
                          </p>
                        </div>
                      ))}
                      <div>
                        <span className="nf-radius-pill">∞</span>
                        <p>Chips & primary CTA</p>
                      </div>
                    </div>
                    <p className="nf-muted">
                      4px spacing scale · 36–44px controls · 1px quiet borders · 160ms hover
                      transitions
                    </p>
                  </section>
                </div>
              ) : kitTab === "Components" ? (
                <div className="nf-kit-sections">
                  <section>
                    <div className="nf-kit-label">01 / ACTIONS</div>
                    <h2>Buttons and actions</h2>
                    <div className="nf-kit-row">
                      <Button primary onClick={() => notify("Primary action")}>
                        Get clips
                        <ArrowRight size={15} />
                      </Button>
                      <Button onClick={() => notify("Secondary action")}>
                        <Upload size={15} />
                        Upload file
                      </Button>
                      <button
                        type="button"
                        className="nf-text-button"
                        onClick={() => notify("Text action")}
                      >
                        View all
                        <ArrowRight size={15} />
                      </button>
                      <Button disabled>Unavailable</Button>
                      <Button disabled>
                        <LoaderCircle size={15} className="nf-spin" />
                        Processing
                      </Button>
                      <IconButton
                        icon={Star}
                        label="Favorite example"
                        active={kitSwitch}
                        onClick={() => setKitSwitch(!kitSwitch)}
                      />
                    </div>
                  </section>
                  <section>
                    <div className="nf-kit-label">02 / INPUTS</div>
                    <div className="nf-kit-inputs">
                      <label>
                        Project name
                        <input defaultValue="A story worth sharing" />
                      </label>
                      <label>
                        Video language
                        <select defaultValue="Detect automatically">
                          <option>Detect automatically</option>
                          <option>English</option>
                          <option>Spanish</option>
                        </select>
                      </label>
                      <label>
                        Find a specific moment
                        <textarea placeholder="e.g. The part about building a creative habit" />
                      </label>
                      <div>
                        <span className="nf-field-label">Clip length</span>
                        <Segments
                          values={["Auto", "< 30s", "30–60s", "60–90s"]}
                          value={length}
                          onChange={setLength}
                        />
                        <Toggle
                          label="Auto-hook"
                          text="Start with a stronger opening"
                          checked={kitSwitch}
                          onChange={setKitSwitch}
                        />
                      </div>
                    </div>
                  </section>
                  <section>
                    <div className="nf-kit-label">03 / FEEDBACK</div>
                    <div className="nf-kit-row">
                      <Pill tone="green">
                        <Check size={12} />
                        Ready
                      </Pill>
                      <Pill tone="blue">
                        <LoaderCircle size={12} className="nf-spin" />
                        Processing
                      </Pill>
                      <Pill tone="yellow">Needs review</Pill>
                      <Pill tone="red">Import failed</Pill>
                      <Pill>Draft</Pill>
                    </div>
                    <div className="nf-inline-error">
                      We couldn't access this video. Try another link or upload the file.
                    </div>
                    <div className="nf-kit-row">
                      <Button onClick={() => notify("Your changes have been saved.")}>
                        Show success toast
                      </Button>
                      <Button
                        onClick={() => {
                          setRename("My new project");
                          setActiveClipId(0);
                          setModal("rename");
                        }}
                      >
                        Open dialog
                      </Button>
                      <Button onClick={() => openAction("publish")}>Open drawer</Button>
                    </div>
                  </section>
                </div>
              ) : (
                <div className="nf-kit-sections">
                  <section>
                    <div className="nf-kit-label">01 / MEDIA & PROJECT CARDS</div>
                    {projectGrid()}
                  </section>
                  <section>
                    <div className="nf-kit-label">02 / EMPTY STATE</div>
                    <Empty
                      title="Room for your next idea"
                      text="Import your first video to start finding clips."
                    >
                      <Button primary onClick={() => openImport()}>
                        Import a video
                        <Plus size={15} />
                      </Button>
                    </Empty>
                  </section>
                  <section>
                    <div className="nf-kit-label">03 / WORKFLOW PATTERNS</div>
                    <div className="nf-kit-row">
                      <Button onClick={() => openImport()}>Import & configure</Button>
                      <Button
                        onClick={() => {
                          setProgress(0);
                          navigate("processing");
                        }}
                      >
                        Processing
                      </Button>
                      <Button onClick={() => openProject()}>Clip review & batch actions</Button>
                      <Button onClick={() => openAction("export")}>Export flow</Button>
                    </div>
                  </section>
                </div>
              )}
            </>
          )}
          {!["home", "projects", "project", "processing", "kit"].includes(view) && (
            <>
              <div className="nf-page-heading">
                <div>
                  <div className="nf-eyebrow">WORKSPACE</div>
                  <h1>{labels[view]}</h1>
                  <p>
                    {view === "autopilot"
                      ? "Keep creating, even between uploads."
                      : view === "exports"
                        ? "Your finished clips, all in one place."
                        : view === "calendar"
                          ? "Publishing calendar"
                          : view === "brand"
                            ? "Make every clip unmistakably yours."
                            : "Bring your workflow together."}
                  </p>
                </div>
                <Pill>Feature preview</Pill>
              </div>
              {view === "exports" && hasExport ? (
                <div className="nf-export-row">
                  <span className="nf-tool-icon blue">
                    <Film size={22} />
                  </span>
                  <div>
                    <h3>{activeClip.title}</h3>
                    <p>
                      Demo export · {quality} · {ratio}
                    </p>
                  </div>
                  <Pill tone="green">Ready</Pill>
                  <Button onClick={downloadSample}>
                    Download sample
                    <ArrowDownToLine size={15} />
                  </Button>
                </div>
              ) : view === "calendar" && scheduled ? (
                <div className="nf-calendar-event">
                  <span className="nf-calendar-date">
                    <strong>{publishDate.slice(-2)}</strong>
                    <small>SEP</small>
                  </span>
                  <div>
                    <Pill tone="blue">Scheduled demo</Pill>
                    <h2>{activeClip.title}</h2>
                    <p>
                      {publishChannel} · {publishTime} · Asia/Karachi
                    </p>
                  </div>
                  <Button onClick={() => openAction("publish")}>Edit schedule</Button>
                </div>
              ) : (
                <Empty
                  icon={
                    view === "autopilot"
                      ? Bot
                      : view === "brand"
                        ? Palette
                        : view === "integrations"
                          ? Plug
                          : view === "calendar"
                            ? CalendarDays
                            : ArrowDownToLine
                  }
                  title={
                    view === "autopilot"
                      ? "Your channel. A steady stream of clips."
                      : view === "brand"
                        ? "A consistent look, in a single click."
                        : view === "integrations"
                          ? "Your tools, connected."
                          : view === "calendar"
                            ? "Your next post belongs here."
                            : "Your best clips, ready to go."
                  }
                  text={
                    view === "autopilot"
                      ? "Connect a YouTube channel or RSS feed, choose your defaults, and review new clips as they arrive."
                      : view === "brand"
                        ? "Bring together your logo, fonts, colors, and caption presets."
                        : view === "integrations"
                          ? "Connect publishing accounts, access the MCP server, and work with your existing tools."
                          : view === "calendar"
                            ? "Schedule a clip from the project page to see it on your calendar."
                            : "Export a clip from a project to try the delivery workflow."
                  }
                >
                  <Button
                    primary
                    onClick={() =>
                      view === "calendar"
                        ? openAction("publish")
                        : view === "exports"
                          ? openProject()
                          : notify(
                              `${labels[view]} remains available in the full product. This demo focuses on the clip creation journey.`,
                            )
                    }
                  >
                    {view === "calendar"
                      ? "Schedule a clip"
                      : view === "exports"
                        ? "Explore a project"
                        : "Explore setup"}
                    <ArrowRight size={15} />
                  </Button>
                </Empty>
              )}
            </>
          )}
        </main>
        <footer className="nf-demo-bar">
          <span>
            <i />
            Prototype
          </span>
          <button
            type="button"
            className={view === "kit" ? "active" : ""}
            onClick={() => navigate(view === "kit" ? "home" : "kit")}
          >
            {view === "kit" ? "Dashboard" : "UI kit"}
            <ArrowUpRight />
          </button>
          <span className="nf-demo-divider" />
          <label>
            State
            <select
              aria-label="Demo state"
              value={scenario}
              onChange={(e) => {
                setScenario(e.target.value);
                if (e.target.value === "Import failed") {
                  setImportStep(0);
                  setImportError(
                    "We couldn’t access this video. Try another link or upload a file.",
                  );
                  setModal("import");
                }
              }}
            >
              <option>Populated</option>
              <option>Empty</option>
              <option>Loading</option>
              <option>Import failed</option>
            </select>
          </label>
          <button
            type="button"
            title="Reset demo"
            onClick={() => {
              setClips(seedClips);
              setSelected([]);
              setScenario("Populated");
              setScheduled(false);
              setProcessingActive(false);
              setHasExport(false);
              setExported(false);
              setLink("");
              navigate("home");
              notify("Demo reset");
            }}
          >
            Reset
          </button>
        </footer>
      </div>
      <dialog
        ref={dialog}
        className={`nf-dialog ${modal === "publish" ? "drawer" : ""} ${modal === "preview" ? "preview" : ""} ${modal === "import" ? (importStep === 0 ? "import-start" : "wide") : ""}`}
        onCancel={() => setModal(null)}
        onClose={() => setModal(null)}
        aria-labelledby="nf-dialog-title"
      >
        <div className="nf-dialog-head">
          <div>
            {modal === "import" && (
              <span className="nf-dialog-kicker">
                New project <span>{importStep === 0 ? "1 / 2" : "2 / 2"}</span>
              </span>
            )}
            <h2 id="nf-dialog-title">
              {modal === "import"
                ? importStep === 0
                  ? "Import a video"
                  : "Clip settings"
                : modal === "preview"
                  ? "Preview & quick edits"
                  : modal === "export"
                    ? exported
                      ? "Export ready"
                      : "Export your clips"
                    : modal === "publish"
                      ? "Publish to social"
                      : modal === "share"
                        ? "Share project"
                        : modal === "rename"
                          ? "Rename project"
                          : modal === "delete"
                            ? "Delete this clip?"
                            : modal === "search"
                              ? "Search workspace"
                              : modal === "workspace"
                                ? "Your workspaces"
                                : modal === "settings"
                                  ? "Workspace settings"
                                  : "Help"}
            </h2>
          </div>
          <IconButton icon={X} label="Close dialog" onClick={() => setModal(null)} />
        </div>
        {modal === "import" &&
          (importStep === 0 ? (
            <>
              <fieldset className="nf-source-options" aria-label="Import source">
                {[
                  {
                    name: "Link",
                    title: "Paste a link",
                    description: "Import from YouTube, Vimeo, or a direct video URL.",
                    icon: Link2,
                  },
                  {
                    name: "Upload",
                    title: "Upload a file",
                    description: "Choose a video or audio file from your device.",
                    icon: Upload,
                  },
                  {
                    name: "RSS feed",
                    title: "Podcast feed",
                    description: "Import an episode from a public RSS feed.",
                    icon: AudioLines,
                  },
                ].map(({ name, title, description, icon: Icon }) => (
                  <button
                    type="button"
                    key={name}
                    aria-pressed={importMethod === name}
                    onClick={() => {
                      setImportMethod(name);
                      setImportError("");
                    }}
                  >
                    <span className="nf-source-tile">
                      <Icon size={30} strokeWidth={1.4} />
                    </span>
                    <strong>{title}</strong>
                    <small>{description}</small>
                  </button>
                ))}
              </fieldset>
              <div className="nf-source-entry">
                {importMethod === "Upload" ? (
                  <label className="nf-upload-zone">
                    <span className="nf-empty-icon">
                      <Upload size={24} />
                    </span>
                    <strong>{fileName || "Choose your video"}</strong>
                    <span>or click to browse your files</span>
                    <small>MP4, MOV, WebM, MP3 · up to 5 GB</small>
                    <input
                      type="file"
                      accept="video/*,audio/*"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file && file.size > 5 * 1024 ** 3) {
                          setImportError("Choose a file smaller than 5 GB.");
                          return;
                        }
                        setFileName(file?.name ?? "");
                        setImportError("");
                      }}
                    />
                  </label>
                ) : (
                  <label className="nf-field-label">
                    {importMethod === "RSS feed" ? "Podcast feed URL" : "Video link"}
                    <div className="nf-input-with-icon">
                      <Link2 size={17} />
                      <input
                        autoComplete="off"
                        placeholder={
                          importMethod === "RSS feed"
                            ? "https://your-podcast.com/feed"
                            : "https://youtube.com/watch?v=..."
                        }
                        value={link}
                        onChange={(e) => {
                          setLink(e.target.value);
                          setImportError("");
                        }}
                      />
                    </div>
                  </label>
                )}
                {importError && (
                  <div className="nf-inline-error" role="alert">
                    {importError}
                  </div>
                )}
                <div className="nf-dialog-footer">
                  <span className="nf-muted">120 minutes available</span>
                  <Button primary onClick={prepareImport}>
                    Continue
                    <ArrowRight size={15} />
                  </Button>
                </div>
              </div>
              <p className="nf-fixture-note">
                Design demo. Your link or file stays in this browser. Results use fictional sample
                clips.
              </p>
            </>
          ) : (
            <>
              <div className="nf-source-summary">
                <img src={thumbnail} alt="Sample source video" />
                <div>
                  <strong>{importMethod === "Upload" ? fileName : projectTitle}</strong>
                  <small>
                    <Youtube size={13} />
                    9:56 · English · Sample video
                  </small>
                </div>
                <Pill tone="green">
                  <Check size={12} />
                  Ready
                </Pill>
              </div>
              <div className="nf-config-grid">
                <div>
                  <div className="nf-field-label">Clip length</div>
                  <Segments
                    values={["Auto", "< 30s", "30–60s", "60–90s"]}
                    value={length}
                    onChange={setLength}
                  />
                </div>
                <div>
                  <div className="nf-field-label">Aspect ratio</div>
                  <Segments
                    values={["9:16", "1:1", "16:9", "4:5"]}
                    value={ratio}
                    onChange={setRatio}
                  />
                </div>
              </div>
              <div className="nf-section-heading compact">
                <h3>Caption style</h3>
                <span>You can change this later</span>
              </div>
              <div className="nf-caption-presets">
                {["Studio", "Bold", "Minimal", "Highlight"].map((name, i) => (
                  <button
                    type="button"
                    className={preset === name ? "selected" : ""}
                    aria-pressed={preset === name}
                    key={name}
                    onClick={() => setPreset(name)}
                  >
                    <span className={`nf-preset-preview preset-${i}`}>
                      <span>
                        {i === 0 ? "Make it" : "YOUR NEXT"}
                        <br />
                        <b>{i === 0 ? "worth watching." : "GREAT MOMENT"}</b>
                      </span>
                    </span>
                    <span className="nf-preset-name">
                      {name}
                      {preset === name && <Check size={13} />}
                    </span>
                  </button>
                ))}
              </div>
              <div className="nf-toggle-group">
                <Toggle
                  label="Auto-hook"
                  text="Find clips that open with a strong first line"
                  checked={autoHook}
                  onChange={setAutoHook}
                />
                <Toggle
                  label="Prepare previews automatically"
                  checked={autoRender}
                  onChange={setAutoRender}
                />
              </div>
              <button
                type="button"
                className="nf-advanced-trigger"
                aria-expanded={advanced}
                onClick={() => setAdvanced(!advanced)}
              >
                <SlidersHorizontal size={15} />
                More control
                <ChevronDown size={15} />
              </button>
              {advanced && (
                <div className="nf-advanced-fields">
                  <label>
                    Find specific moments
                    <textarea placeholder="e.g. The part about the new camera" />
                  </label>
                  <div className="nf-config-grid">
                    <label>
                      Language
                      <select defaultValue="Auto-detect">
                        <option>Auto-detect</option>
                        <option>English</option>
                        <option>Spanish</option>
                      </select>
                    </label>
                    <label>
                      Target platform
                      <select>
                        <option>All platforms</option>
                        <option>YouTube Shorts</option>
                        <option>Instagram Reels</option>
                        <option>TikTok</option>
                      </select>
                    </label>
                  </div>
                  <label>
                    Processing range
                    <input placeholder="Full video, or e.g. 00:30–08:00" />
                  </label>
                </div>
              )}
              <div className="nf-dialog-footer">
                <button type="button" className="nf-text-button" onClick={() => setImportStep(0)}>
                  <ArrowLeft size={14} />
                  Back
                </button>
                <Button primary onClick={generate}>
                  Get AI clips
                  <Sparkles size={15} />
                </Button>
              </div>
              <p className="nf-fixture-note">
                Simulated processing · approximately 10 minutes of your monthly allowance in the
                full product
              </p>
            </>
          ))}
        {modal === "preview" && (
          <div className="nf-preview-layout">
            <div className="nf-preview-player">
              <div
                className={`nf-preview-stage caption-${preset.toLowerCase()}`}
                style={{
                  aspectRatio: ratio.replace(":", "/"),
                  maxWidth: ratio === "9:16" ? 264 : 420,
                }}
              >
                <video
                  controls
                  playsInline
                  preload="metadata"
                  poster={thumbnail}
                  src="/videos/caption-loop.mp4"
                >
                  <track kind="captions" src="/prototype-sample.vtt" srcLang="en" label="English" />
                </video>
                <span className="nf-caption-overlay">
                  {activeClip.caption.split("\n").map((line, i) => (
                    <span className={i === 1 ? "accent" : ""} key={line}>
                      {line}
                    </span>
                  ))}
                </span>
              </div>
              <small>Sample playback · changes stay in this demo</small>
            </div>
            <div className="nf-preview-controls">
              <Pill tone="green">
                <Sparkles size={12} />
                {activeClip.score} score
              </Pill>
              <h3>{activeClip.title}</h3>
              <div className="nf-field-label">Aspect ratio</div>
              <Segments values={["9:16", "1:1", "16:9"]} value={ratio} onChange={setRatio} />
              <div className="nf-field-label">Caption preset</div>
              <Segments
                values={["Studio", "Bold", "Minimal"]}
                value={preset}
                onChange={setPreset}
              />
              <label className="nf-field-label">
                Clip transcript
                <textarea
                  value={activeClip.quote}
                  onChange={(e) =>
                    setClips(
                      clips.map((c) =>
                        c.id === activeClip.id ? { ...c, quote: e.target.value } : c,
                      ),
                    )
                  }
                  rows={5}
                />
              </label>
              <div className="nf-inline-note">
                <Clapperboard size={17} />
                <p>
                  Full timeline and scene editing live in Studio. This demo covers quick review and
                  handoff.
                </p>
              </div>
              <Button
                primary
                onClick={() => {
                  setModal("export");
                  setExported(false);
                }}
              >
                <ArrowDownToLine size={15} />
                Export clip
              </Button>
            </div>
          </div>
        )}
        {modal === "export" &&
          (exported ? (
            <div className="nf-export-success">
              <span className="nf-success-circle">
                <CheckCheck size={30} />
              </span>
              <h3>
                {actionCount} {actionCount === 1 ? "clip" : "clips"}, ready to share.
              </h3>
              <p>
                {quality} · {ratio} · {preset} captions
              </p>
              <Pill tone="green">Demo export complete</Pill>
              <Button primary onClick={downloadSample}>
                <ArrowDownToLine size={16} />
                Download sample {exportFormat === "Subtitles" ? "subtitles" : "transcript"}
              </Button>
              <p className="nf-fixture-note">
                Rendering is simulated. Downloads contain sample text.
              </p>
              <button
                type="button"
                className="nf-text-button"
                onClick={() => {
                  setModal(null);
                  navigate("exports");
                }}
              >
                View exports
                <ArrowRight size={15} />
              </button>
            </div>
          ) : (
            <>
              <p className="nf-dialog-description">
                {actionCount === 1 ? activeClip.title : `${actionCount} selected clips`}
              </p>
              <Segments
                values={["Video", "Subtitles", "Transcript"]}
                value={exportFormat}
                onChange={setExportFormat}
              />
              {exportFormat === "Video" && (
                <>
                  <div className="nf-field-label">Resolution</div>
                  <Segments
                    values={["720p", "1080p", "4K"]}
                    value={quality}
                    onChange={setQuality}
                  />
                  <Toggle
                    label="Burn in captions"
                    text={`${preset} · ${ratio}`}
                    checked={autoRender}
                    onChange={setAutoRender}
                  />
                </>
              )}
              <div className="nf-export-summary">
                <span>Format</span>
                <strong>
                  {exportFormat === "Video"
                    ? "MP4 · H.264"
                    : exportFormat === "Subtitles"
                      ? "SRT"
                      : "Plain text"}
                </strong>
                <span>Clips</span>
                <strong>{actionCount}</strong>
                <span>Delivery</span>
                <strong>Download</strong>
              </div>
              <div className="nf-dialog-footer">
                <Button onClick={() => setModal(null)}>Cancel</Button>
                <Button primary disabled={exportBusy} onClick={runExport}>
                  {exportBusy ? (
                    <LoaderCircle size={15} className="nf-spin" />
                  ) : (
                    <ArrowDownToLine size={15} />
                  )}{" "}
                  {exportBusy ? "Preparing..." : "Create export"}
                </Button>
              </div>
            </>
          ))}
        {modal === "publish" && (
          <>
            <p className="nf-dialog-description">Your clip, ready for the right moment.</p>
            <div className="nf-publish-clip">
              <span className="nf-publish-thumb" style={{ backgroundImage: `url(${thumbnail})` }} />
              <div>
                <strong>{activeClip.title}</strong>
                <small>
                  {actionCount > 1
                    ? `${actionCount} clips selected`
                    : `${activeClip.duration} · ${ratio} · ${quality}`}
                </small>
              </div>
            </div>
            <div className="nf-section-heading compact">
              <h3>Publish to</h3>
              <button
                type="button"
                className="nf-text-button"
                onClick={() => setConnected(!connected)}
              >
                {connected ? "Manage" : "Use demo accounts"}
              </button>
            </div>
            {connected ? (
              <>
                <div className="nf-channel-options">
                  {["Instagram", "YouTube", "TikTok", "LinkedIn"].map((channel, i) => (
                    <button
                      type="button"
                      aria-pressed={publishChannel === channel}
                      className={publishChannel === channel ? "active" : ""}
                      key={channel}
                      onClick={() => setPublishChannel(channel)}
                    >
                      <span className={`nf-channel-symbol channel-${i}`}>
                        {["◎", "▶", "♪", "in"][i]}
                      </span>
                      <span>
                        {channel}
                        <small>@murtazacreates</small>
                      </span>
                      {publishChannel === channel && <Check size={15} />}
                    </button>
                  ))}
                </div>
                <label className="nf-field-label">
                  Post caption
                  <textarea
                    value={publishCopy}
                    onChange={(e) => setPublishCopy(e.target.value)}
                    rows={5}
                  />
                </label>
                <Segments
                  values={["Schedule", "Publish now"]}
                  value={publishMode}
                  onChange={setPublishMode}
                />
                {publishMode === "Schedule" && (
                  <>
                    <div className="nf-config-grid">
                      <label>
                        Date
                        <input
                          type="date"
                          value={publishDate}
                          onChange={(e) => setPublishDate(e.target.value)}
                        />
                      </label>
                      <label>
                        Time
                        <input
                          type="time"
                          value={publishTime}
                          onChange={(e) => setPublishTime(e.target.value)}
                        />
                      </label>
                    </div>
                    <p className="nf-timezone">
                      <Globe2 size={13} />
                      Asia/Karachi · UTC+05:00
                    </p>
                  </>
                )}
                <div className="nf-drawer-footer">
                  <p>
                    <ShieldCheck size={14} />
                    Demo only. Nothing will be posted.
                  </p>
                  <Button
                    primary
                    onClick={() => {
                      setScheduled(true);
                      setModal(null);
                      notify(
                        publishMode === "Schedule"
                          ? `Demo post scheduled for ${publishDate} at ${publishTime}`
                          : "Demo post published. No content was sent.",
                      );
                    }}
                  >
                    {publishMode === "Schedule" ? <CalendarDays size={16} /> : <Send size={16} />}{" "}
                    {publishMode === "Schedule" ? "Schedule post" : "Publish demo post"}
                  </Button>
                </div>
              </>
            ) : (
              <Empty
                icon={Plug}
                title="Connect your first account"
                text="Choose where you'd like to share your clips."
              >
                <Button primary onClick={() => setConnected(true)}>
                  Use demo accounts
                  <Plus size={15} />
                </Button>
              </Empty>
            )}
          </>
        )}
        {modal === "share" && (
          <>
            <p className="nf-dialog-description">Give someone a closer look at your work.</p>
            <div className="nf-share-access">
              <Globe2 size={22} />
              <div>
                <strong>Anyone with the link</strong>
                <small>Can view this demo</small>
              </div>
              <Pill>View only</Pill>
            </div>
            <label className="nf-field-label">
              Preview link
              <div className="nf-share-link">
                <input readOnly value="http://localhost:3000/prototype/dashboard?view=project" />
                <Button
                  primary
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(
                        `${window.location.origin}/prototype/dashboard?view=project`,
                      );
                      setShareCopied(true);
                    } catch {
                      notify("Select and copy the link above.");
                    }
                  }}
                >
                  {shareCopied ? <Check size={14} /> : <Copy size={14} />}{" "}
                  {shareCopied ? "Copied" : "Copy"}
                </Button>
              </div>
            </label>
            <p className="nf-fixture-note">
              Local preview links work on this computer. No project permissions are changed.
            </p>
          </>
        )}
        {modal === "rename" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!rename.trim()) return;
              if (activeClipId === 0) {
                setProjectNames(
                  Object.fromEntries([
                    ...Object.entries(projectNames).map(([key, value]) => [
                      key,
                      value === projectTitle ? rename.trim() : value,
                    ]),
                    [projectTitle, rename.trim()],
                  ]),
                );
                setProjectTitle(rename.trim());
              } else
                setClips(
                  clips.map((c) => (c.id === activeClipId ? { ...c, title: rename.trim() } : c)),
                );
              setModal(null);
              notify("Name updated in demo");
            }}
          >
            <label className="nf-field-label">
              Name
              <input
                autoComplete="off"
                required
                maxLength={160}
                value={rename}
                onChange={(e) => setRename(e.target.value)}
              />
            </label>
            <div className="nf-dialog-footer">
              <Button onClick={() => setModal(null)}>Cancel</Button>
              <button type="submit" className="nf-button primary">
                Save name
                <Check size={14} />
              </button>
            </div>
          </form>
        )}
        {modal === "delete" && (
          <>
            <p className="nf-dialog-description">
              “{activeClip.title}” will be removed from this demo. Reset the demo to bring it back.
            </p>
            <div className="nf-dialog-footer">
              <Button onClick={() => setModal(null)}>Keep clip</Button>
              <Button
                className="danger"
                onClick={() => {
                  setClips(clips.filter((c) => c.id !== activeClipId));
                  setSelected(selected.filter((id) => id !== activeClipId));
                  setModal(null);
                  notify("Clip removed from demo");
                }}
              >
                <Trash2 size={15} />
                Delete clip
              </Button>
            </div>
          </>
        )}
        {modal === "search" && (
          <>
            <label className="nf-input-with-icon">
              <Search size={18} />
              <input
                placeholder="Search projects, tools, and pages..."
                aria-label="Global search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <kbd>ESC</kbd>
            </label>
            <div className="nf-search-results">
              {[
                { name: projectTitle, go: () => openProject(), icon: Film },
                ...nav.map((n) => ({ name: n.label, go: () => navigate(n.view), icon: n.icon })),
                { name: "UI kit", go: () => navigate("kit"), icon: Grid2X2 },
              ]
                .filter((item) => item.name.toLowerCase().includes(search.toLowerCase()))
                .map(({ name, go, icon: Icon }) => (
                  <button
                    type="button"
                    key={name}
                    onClick={() => {
                      setModal(null);
                      go();
                    }}
                  >
                    <Icon size={18} />
                    <span>{name}</span>
                    <ArrowRight size={15} />
                  </button>
                ))}
            </div>
          </>
        )}
        {modal === "workspace" && (
          <>
            <div className="nf-workspace-option">
              <span className="nf-avatar">M</span>
              <div>
                <strong>{workspaceName}</strong>
                <small>Creator · 1 member</small>
              </div>
              <Check size={17} />
            </div>
            <Button onClick={() => notify("Workspace creation is outside this design demo.")}>
              <Plus size={15} />
              Create workspace
            </Button>
          </>
        )}
        {modal === "help" && (
          <>
            <p className="nf-dialog-description">Try the entire journey with sample data.</p>
            <div className="nf-help-steps">
              {[
                "Paste a link or upload a file",
                "Choose your clip and caption settings",
                "Review, favorite, and select clips",
                "Export a sample or schedule a demo post",
              ].map((t, i) => (
                <p key={t}>
                  <span>{i + 1}</span>
                  {t}
                </p>
              ))}
            </div>
            <div className="nf-shortcut-row">
              <span>Search anything</span>
              <kbd>⌘ K</kbd>
            </div>
            <div className="nf-shortcut-row">
              <span>Close a dialog or menu</span>
              <kbd>Esc</kbd>
            </div>
            <p className="nf-fixture-note">
              Use the bottom toolbar to inspect empty, loading, and failure states. All sample data
              resets on refresh.
            </p>
          </>
        )}
        {modal === "settings" && (
          <>
            <label className="nf-field-label">
              Workspace name
              <input value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} />
            </label>
            <label className="nf-field-label">
              Appearance
              <select defaultValue="Dark">
                <option>Dark</option>
              </select>
            </label>
            <Toggle
              label="Notify me when clips are ready"
              checked={kitSwitch}
              onChange={setKitSwitch}
            />
            <div className="nf-dialog-footer">
              <Pill>Creator plan</Pill>
              <Button
                primary
                onClick={() => {
                  setModal(null);
                  notify("Demo preferences saved for this session");
                }}
              >
                Save preferences
              </Button>
            </div>
          </>
        )}
      </dialog>
      {toast && (
        <div className="nf-toast" role="status">
          <span>
            <Check size={15} />
          </span>
          {toast}
          <IconButton icon={X} label="Dismiss notification" onClick={() => setToast("")} />
        </div>
      )}
    </div>
  );
}
function ArrowUpRight() {
  return <ArrowRight size={15} className="nf-arrow-up" />;
}
