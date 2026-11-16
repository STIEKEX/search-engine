import { useEffect, useState } from "react";

// Per-browser preferences (theme, open links in a new tab, show scores).
// localStorage can be missing or throw (private mode, blocked storage), so
// every access is wrapped: the page must work without it, just forgetting.

const KEY = "minisearch.prefs";
export const DEFAULT_PREFS = { theme: "system", newTab: false, showScores: false };

function load() {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function save(prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // not saved: fine
  }
}

/** Apply the theme: "system" follows the OS; "light"/"dark" override it (see styles.css). */
export function applyTheme(theme) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

/** Current theme as shown on screen ("light" or "dark"). */
export function effectiveTheme(theme) {
  if (theme !== "system") return theme;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function usePrefs() {
  const [prefs, setPrefs] = useState(load);
  useEffect(() => {
    save(prefs);
    applyTheme(prefs.theme);
  }, [prefs]);
  const update = (changes) => setPrefs((p) => ({ ...p, ...changes }));
  return [prefs, update];
}
