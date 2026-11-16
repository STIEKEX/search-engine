import { useEffect, useRef, useState } from "react";
import { corpusSizeApi, newViewId, searchApi } from "./api.js";
import { usePrefs } from "./prefs.js";
import Header from "./components/Header.jsx";
import TrendingPage from "./components/TrendingPage.jsx";
import { Monogram } from "./components/Icons.jsx";
import Pagination from "./components/Pagination.jsx";
import ResultList from "./components/ResultList.jsx";
import SearchBox from "./components/SearchBox.jsx";
import SourceTabs from "./components/SourceTabs.jsx";
import { Toasts, useToasts } from "./components/Toasts.jsx";

const DEFAULTS = { q: "", page: 1, rank: "bm25", mode: "all", exact: false, source: "all" };
// Real queries that return results in this index (checked by hand).
const EXAMPLES = ["gothic cathedral", "system design interview", "large language models", "french revolution"];

// The search lives in the page URL (?q=...&page=2), so a search can be
// shared as a link, and the browser's Back button returns to the previous one.
// `sid` (the analytics id of this view) is NOT in the URL: opening the same
// link again is a new view, so it gets a new id.
function readUrl() {
  const p = new URLSearchParams(window.location.search);
  return {
    q: p.get("q") ?? DEFAULTS.q,
    page: Math.max(1, Number(p.get("page")) || 1),
    rank: p.get("rank") ?? DEFAULTS.rank,
    mode: p.get("mode") ?? DEFAULTS.mode,
    exact: p.get("exact") === "true", // "Search instead for ..." was clicked
    source: p.get("source") ?? DEFAULTS.source,
    sid: newViewId(),
  };
}

function urlFor(state) {
  const p = new URLSearchParams();
  for (const [key, value] of Object.entries(state)) if (key !== "sid" && value !== DEFAULTS[key]) p.set(key, String(value));
  const query = p.toString();
  return query ? `/?${query}` : "/";
}

const isTrending = () => window.location.pathname.replace(/\/+$/, "") === "/trending";

export default function App() {
  const [search, setSearch] = useState(readUrl);
  const [onTrending, setOnTrending] = useState(isTrending);
  const [response, setResponse] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [corpusSize, setCorpusSize] = useState(null);
  const [prefs, setPrefs] = usePrefs();
  const [toasts, toast] = useToasts();
  const homeInput = useRef(null);
  const headerInput = useRef(null);

  // Back/forward buttons: show the page and search from the URL.
  useEffect(() => {
    const onPop = () => {
      setOnTrending(isTrending());
      setSearch(readUrl());
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // "/" focuses the search box (unless you're already typing somewhere).
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const input = (homeInput.current ?? headerInput.current);
      if (!input) return;
      e.preventDefault();
      input.focus();
      input.select();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // The home page says how many pages are searchable: a real number.
  useEffect(() => {
    const controller = new AbortController();
    corpusSizeApi(controller.signal).then(setCorpusSize);
    return () => controller.abort();
  }, []);

  // Run the search whenever it changes. AbortController cancels the previous
  // request, so a slow old answer can never overwrite a newer one.
  useEffect(() => {
    if (onTrending || !search.q.trim()) {
      setResponse(null);
      setError(null);
      return undefined;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    searchApi(search, controller.signal)
      .then((body) => setResponse(body))
      .catch((err) => {
        if (err.name !== "AbortError") {
          setResponse(null);
          setError(err.message);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [search, onTrending]);

  /** Go to a new search state: new URL, new view id. */
  function update(changes) {
    const next = { ...search, ...changes, sid: newViewId() };
    window.history.pushState(null, "", urlFor(next));
    setOnTrending(false);
    setSearch(next);
    window.scrollTo({ top: 0 });
  }

  function navigate(path) {
    if (path === "/trending") {
      window.history.pushState(null, "", "/trending");
      setOnTrending(true);
      window.scrollTo({ top: 0 });
    } else {
      update(DEFAULTS);
    }
  }

  function changePrefs(changes, message) {
    setPrefs(changes);
    if (message) toast(message);
  }

  const runQuery = (q) => update({ q, page: 1, exact: false });
  const headerProps = {
    prefs,
    onPrefs: changePrefs,
    search,
    // Ranking/match changes re-run the current search (if there is one).
    onSearchOptions: (changes) => (search.q.trim() ? update({ ...changes, page: 1 }) : setSearch({ ...search, ...changes })),
    onHome: () => update(DEFAULTS),
    onNavigate: navigate,
  };

  // ------------------------------------------------------------ trending
  if (onTrending) {
    return (
      <div className="app">
        <Header variant="trending" {...headerProps} />
        <TrendingPage onSearch={runQuery} prefs={prefs} />
        <Toasts toasts={toasts} />
      </div>
    );
  }

  // ------------------------------------------------------------ home
  if (!search.q.trim()) {
    return (
      <div className="app app--home">
        <Header variant="home" {...headerProps}>
          <SourceTabs look="pills" value={search.source} onChange={(source) => setSearch({ ...search, source })} />
        </Header>
        <main className="home">
          <div className="home__brand">
            <Monogram size={44} />
            <h1 className="home__name">minisearch</h1>
            <p className="home__tagline">
              {corpusSize ? `Quiet, direct search over ${corpusSize.toLocaleString("en-US")} pages from Wikipedia and Medium` : "Quiet, direct search over Wikipedia and Medium"}
            </p>
          </div>
          <SearchBox ref={homeInput} size="large" initialQ="" onSearch={runQuery} autoFocus />
          <div className="examples">
            {EXAMPLES.map((q) => (
              <button key={q} type="button" className="chip" onClick={() => runQuery(q)}>
                {q}
              </button>
            ))}
          </div>
        </main>
        <footer className="footer mono">
          BM25 ranking · built from scratch · press <kbd className="kbd kbd--inline">/</kbd> to search
        </footer>
        <Toasts toasts={toasts} />
      </div>
    );
  }

  // ------------------------------------------------------------ results
  return (
    <div className="app">
      <Header variant="results" {...headerProps}>
        <SearchBox ref={headerInput} size="compact" initialQ={search.q} onSearch={runQuery} />
      </Header>
      <div className="tabsbar">
        <div className="container">
          <SourceTabs value={search.source} counts={response?.sourceCounts} onChange={(source) => update({ source, page: 1 })} />
        </div>
      </div>

      <main className="container results-view">
        {error && <p className="error">{error}</p>}
        {loading && !response && <p className="meta mono">Searching…</p>}
        {response && !error && (
          <div className={`results-grid${loading ? " is-refreshing" : ""}`}>
            <div className="results-main">
              <p className="meta">
                {response.total.toLocaleString("en-US")} {response.total === 1 ? "result" : "results"} ({(response.tookMs / 1000).toFixed(2)} seconds)
                {response.missingTerms.length > 0 && <> · no page contains “{response.missingTerms.join("”, “")}”</>}
              </p>
              {response.correction && (
                <p className="correction">
                  Showing results for <strong>{response.correction.corrected}</strong>.{" "}
                  <button type="button" className="linklike" onClick={() => update({ q: response.correction.original, page: 1, exact: true })}>
                    Search instead for {response.correction.original}
                  </button>
                </p>
              )}
              <ResultList
                results={response.results}
                page={response.page}
                limit={response.limit}
                searchId={response.searchId}
                prefs={prefs}
                onAnyWord={response.mode === "all" ? () => update({ mode: "any", page: 1 }) : null}
              />
              <Pagination page={response.page} total={response.total} limit={response.limit} onPage={(page) => update({ page })} />
            </div>
          </div>
        )}
      </main>
      <Toasts toasts={toasts} />
    </div>
  );
}
