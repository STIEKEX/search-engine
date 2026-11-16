// All / Wikipedia / Medium. Two looks: "pills" on the home page (choose
// where to search before typing) and "tabs" under the header on the results
// page, with real result counts per source.

export const SOURCES = [
  { value: "all", label: "All" },
  { value: "wikipedia", label: "Wikipedia" },
  { value: "medium", label: "Medium" },
];

export default function SourceTabs({ value, onChange, counts, look = "tabs" }) {
  return (
    <nav className={look} aria-label="Search in">
      {SOURCES.map((s) => (
        <button
          key={s.value}
          type="button"
          className={`${look}__item${value === s.value ? " is-on" : ""}`}
          aria-pressed={value === s.value}
          onClick={() => onChange(s.value)}
        >
          {s.label}
          {counts && <span className="tabs__count mono">{counts[s.value].toLocaleString("en-US")}</span>}
        </button>
      ))}
    </nav>
  );
}
