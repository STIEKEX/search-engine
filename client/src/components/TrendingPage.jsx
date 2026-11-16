import { useEffect, useState } from "react";
import { trendsApi } from "../api.js";
import { cleanTitle, SiteIcon, siteName } from "./ResultList.jsx";

// The public Trending page: what other people search for and read.
// All lists come from GET /api/trends (server/lib/trends.js), which only
// shows queries searched at least twice that found results.

const fmt = (n) => n.toLocaleString("en-US");

/** "New" for a query nobody searched last week, else how many times more than usual. */
function growthLabel(t) {
  if (t.isNew) return "New";
  return `↑ ${t.growth >= 10 ? Math.round(t.growth) : t.growth.toFixed(1)}×`;
}

function Section({ title, subtitle, children }) {
  return (
    <section className="card">
      <header className="card__head">
        <h2 className="card__title">{title}</h2>
        <p className="card__sub">{subtitle}</p>
      </header>
      {children}
    </section>
  );
}

export default function TrendingPage({ onSearch, prefs }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    trendsApi(controller.signal)
      .then(setData)
      .catch((err) => err.name !== "AbortError" && setError(err.message));
    return () => controller.abort();
  }, []);

  const QueryButton = ({ query }) => (
    <button type="button" className="trend__query" onClick={() => onSearch(query)}>
      {query}
    </button>
  );

  return (
    <main className="trending">
      <div className="trending__head">
        <h1 className="trending__title">Trending</h1>
        <p className="trending__sub">What people are searching for and reading on minisearch. A search appears here once it has been made at least twice.</p>
      </div>
      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="faint mono">Loading…</p>}

      {data && (
        <>
          <Section title="Trending now" subtitle="Searched more in the last 24 hours than in the week before">
            {data.trending.length === 0 ? (
              <p className="faint card__empty">Nothing is rising right now.</p>
            ) : (
              <ol className="trendlist">
                {data.trending.map((t, i) => (
                  <li key={t.query} className="trend">
                    <span className="trend__rank mono">{i + 1}</span>
                    <QueryButton query={t.query} />
                    <span className="trend__meta">{fmt(t.today)} searches today</span>
                    <span className={`badge${t.isNew ? " badge--new" : ""}`}>{growthLabel(t)}</span>
                  </li>
                ))}
              </ol>
            )}
          </Section>

          <div className="grid2">
            <Section title="Most searched" subtitle="Last 7 days">
              {data.popular.length === 0 ? (
                <p className="faint card__empty">No search has been made twice yet.</p>
              ) : (
                <ol className="trendlist">
                  {data.popular.map((p, i) => (
                    <li key={p.query} className="trend">
                      <span className="trend__rank mono">{i + 1}</span>
                      <QueryButton query={p.query} />
                      <span className="trend__meta">{fmt(p.count)} searches</span>
                    </li>
                  ))}
                </ol>
              )}
            </Section>

            <Section title="Popular reads" subtitle="Results people opened most, last 7 days">
              {data.reads.length === 0 ? (
                <p className="faint card__empty">No results opened yet.</p>
              ) : (
                <ol className="reads">
                  {data.reads.map((r) => (
                    <li key={r.url} className="read">
                      <SiteIcon url={r.url} name={siteName(r)} />
                      <span className="read__text">
                        <a className="read__title" href={r.url} {...(prefs.newTab && { target: "_blank", rel: "noopener noreferrer" })}>
                          {cleanTitle(r.title, r.url)}
                        </a>
                        <span className="trend__meta">
                          {siteName(r)} · {fmt(r.readers)} {r.readers === 1 ? "reader" : "readers"}
                        </span>
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </Section>
          </div>
        </>
      )}
    </main>
  );
}
