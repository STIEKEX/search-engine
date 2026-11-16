import { useEffect, useRef, useState } from "react";
import { effectiveTheme } from "../prefs.js";
import { Monogram, MoonIcon, SlidersIcon, SunIcon, TrendIcon } from "./Icons.jsx";

const RANKINGS = [
  { value: "bm25", label: "BM25 (best in evaluation)" },
  { value: "combined", label: "BM25 + PageRank" },
  { value: "tfidf", label: "TF-IDF" },
  { value: "pagerank", label: "PageRank only" },
  { value: "none", label: "Unranked" },
];

/** A toggle switch that is a real checkbox underneath (keyboard + screen readers work). */
function Switch({ label, hint, checked, onChange }) {
  return (
    <label className="pref">
      <span>
        <span className="pref__label">{label}</span>
        <span className="pref__hint">{hint}</span>
      </span>
      <input type="checkbox" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

/** The ⚙ popover: per-browser preferences, plus how the current search ranks and matches. */
function Preferences({ prefs, onPrefs, search, onSearchOptions, onClose }) {
  const ref = useRef(null);
  // Close on a click outside or on Escape.
  useEffect(() => {
    const onDown = (e) => ref.current && !ref.current.contains(e.target) && !e.target.closest("[data-prefs-toggle]") && onClose();
    const onKey = (e) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div className="popover" ref={ref} role="dialog" aria-label="Preferences">
      <div className="popover__head">
        <span className="eyebrow">Preferences</span>
        <span className="mono faint">no tracking cookies</span>
      </div>
      <Switch label="Open links in new tab" hint="Keep your results open" checked={prefs.newTab} onChange={(v) => onPrefs({ newTab: v }, v ? "Links open in a new tab" : "Links open in this tab")} />
      <Switch label="Show ranking scores" hint="BM25 and PageRank under each result" checked={prefs.showScores} onChange={(v) => onPrefs({ showScores: v }, v ? "Scores shown" : "Scores hidden")} />
      <div className="popover__sep" />
      <label className="pref pref--select">
        <span className="pref__label">Ranking</span>
        <select value={search.rank} onChange={(e) => onSearchOptions({ rank: e.target.value })}>
          {RANKINGS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </label>
      <label className="pref pref--select">
        <span className="pref__label">Match</span>
        <select value={search.mode} onChange={(e) => onSearchOptions({ mode: e.target.value })}>
          <option value="all">all words</option>
          <option value="any">any word</option>
        </select>
      </label>
    </div>
  );
}

/**
 * Top bar. On the home page it shows only the source scope and the controls;
 * on results and analytics it also shows the logo and (results) a compact search box.
 */
export default function Header({ variant, children, prefs, onPrefs, search, onSearchOptions, onHome, onNavigate }) {
  const [open, setOpen] = useState(false);
  const theme = effectiveTheme(prefs.theme);
  return (
    <header className={`header header--${variant}`}>
      <div className="header__row">
        <div className="header__left">
          {variant !== "home" && (
            <a className="brand" href="/" onClick={(e) => (e.preventDefault(), onHome())} aria-label="MiniSearch home">
              <Monogram />
              <span className="brand__name">minisearch</span>
            </a>
          )}
          {children}
        </div>
        <div className="header__right">
          <a
            className={`iconbtn${variant === "trending" ? " is-on" : ""}`}
            href="/trending"
            onClick={(e) => (e.preventDefault(), onNavigate("/trending"))}
            title="Trending searches"
            aria-label="Trending searches"
          >
            <TrendIcon />
          </a>
          <button
            type="button"
            className="iconbtn"
            onClick={() => onPrefs({ theme: theme === "dark" ? "light" : "dark" }, theme === "dark" ? "Light theme" : "Dark theme")}
            title="Toggle theme"
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          >
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
          <button type="button" className="iconbtn" data-prefs-toggle onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label="Preferences" title="Preferences">
            <SlidersIcon />
          </button>
          {open && <Preferences prefs={prefs} onPrefs={onPrefs} search={search} onSearchOptions={onSearchOptions} onClose={() => setOpen(false)} />}
        </div>
      </div>
    </header>
  );
}
