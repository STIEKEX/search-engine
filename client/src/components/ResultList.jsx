import { logClick } from "../api.js";

const SITE_SUFFIX = " - Simple English Wikipedia, the free encyclopedia";

/** "https://simple.wikipedia.org/wiki/Gothic_architecture" -> "simple.wikipedia.org › wiki › Gothic architecture" */
export function prettyUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p).replaceAll("_", " "));
    return [u.host, ...parts].join(" › ");
  } catch {
    return url;
  }
}

/** Like real search engines: "https://simple.wikipedia.org › wiki › French_Revolution". */
function breadcrumb(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
    return [`${u.protocol}//${u.host}`, ...parts].join(" › ");
  } catch {
    return url;
  }
}

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};

/** The site's name for the line above the title: "Wikipedia", "Medium", else the host without "www.". */
export function siteName(result) {
  if (result.source === "wikipedia") return "Wikipedia";
  if (result.source === "medium") return "Medium";
  return hostOf(result.url).replace(/^www\./, "");
}

/**
 * The site's own icon, loaded from that site (https://host/favicon.ico),
 * like the browser's tab icon. If it fails, the site's first letter.
 * (Google fetches icons through its own servers; doing that would send every
 * result's site to a third party, so we ask the site itself.)
 */
export function SiteIcon({ url, name }) {
  const host = hostOf(url);
  const letter = (name || host || "?").charAt(0).toUpperCase();
  return (
    <span className="favicon" aria-hidden="true">
      <span className="favicon__letter">{letter}</span>
      {host && (
        <img
          className="favicon__img"
          src={`https://${host}/favicon.ico`}
          alt=""
          width="18"
          height="18"
          loading="lazy"
          referrerPolicy="no-referrer"
          // The letter sits underneath; a broken image is simply removed.
          onError={(e) => e.currentTarget.remove()}
        />
      )}
    </span>
  );
}

export const cleanTitle = (title, url) => (title || url || "").replace(SITE_SUFFIX, "");

/**
 * The snippet arrives as fragments, not HTML: { text, highlight }.
 * React renders text safely (it escapes "<" and friends), so page text can
 * never inject markup; highlighted words become <mark> elements.
 */
function Snippet({ snippet }) {
  if (!snippet || snippet.fragments.length === 0) return null;
  return (
    <p className="result__snippet">
      {snippet.truncatedStart && "… "}
      {snippet.fragments.map((f, i) => (f.highlight ? <mark key={i}>{f.text}</mark> : <span key={i}>{f.text}</span>))}
      {snippet.truncatedEnd && " …"}
    </p>
  );
}

function Result({ result, position, searchId, prefs }) {
  // Logged on middle-click too: "open in new tab" never fires a normal
  // click, but it is a click for CTR.
  const record = () => logClick(searchId, position, result.url);
  const linkProps = {
    href: result.url,
    onClick: record,
    onAuxClick: (e) => e.button === 1 && record(),
    ...(prefs.newTab && { target: "_blank", rel: "noopener noreferrer" }),
  };
  const name = siteName(result);
  return (
    <li className="result">
      {/* The site line is a link too, as on real search engines; hidden from
          screen readers' tab order so each result is ONE stop (the title). */}
      <a className="result__site" {...linkProps} tabIndex={-1} aria-hidden="true">
        <SiteIcon url={result.url} name={name} />
        <span className="result__sitetext">
          <span className="result__sitename">{name}</span>
          <cite className="result__url">{breadcrumb(result.url)}</cite>
        </span>
      </a>
      <h2 className="result__heading">
        <a className="result__title" {...linkProps}>
          {cleanTitle(result.title, result.url)}
        </a>
      </h2>
      <Snippet snippet={result.snippet} />
      {prefs.showScores && result.score !== null && (
        <div className="result__meta mono" title="Why this rank: the scores behind it">
          #{position} · score {result.score.toFixed(3)} · BM25 {result.scores.bm25.toFixed(2)} · PageRank {result.scores.pagerank.toFixed(5)}
        </div>
      )}
    </li>
  );
}

export default function ResultList({ results, page, limit, searchId, prefs, onAnyWord }) {
  if (results.length === 0) {
    return (
      <div className="empty">
        <p>No pages match all of these words.</p>
        {onAnyWord && (
          <button type="button" className="linklike mono" onClick={onAnyWord}>
            Try matching any word
          </button>
        )}
      </div>
    );
  }
  return (
    <ol className="results">
      {results.map((r, i) => (
        <Result key={r.docId} result={r} position={(page - 1) * limit + i + 1} searchId={searchId} prefs={prefs} />
      ))}
    </ol>
  );
}
