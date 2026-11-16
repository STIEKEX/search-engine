import { forwardRef, useEffect, useState } from "react";
import { suggestApi } from "../api.js";
import { ArrowIcon, CloseIcon, SearchIcon } from "./Icons.jsx";

// Wait this long after the last keystroke before asking for suggestions:
// typing "french" then sends 1-2 requests instead of 6.
const DEBOUNCE_MS = 120;

/** Bold the part of a suggestion that matches what was typed (if it is visible as-is). */
function Highlighted({ text, typed }) {
  const at = text.toLowerCase().indexOf(typed.trim().toLowerCase());
  if (!typed.trim() || at === -1) return text;
  const end = at + typed.trim().length;
  return (
    <>
      {text.slice(0, at)}
      <strong>{text.slice(at, end)}</strong>
      {text.slice(end)}
    </>
  );
}

/**
 * The text box with an autocomplete dropdown.
 * size "large" = the home page box; "compact" = the one in the results header.
 */
const SearchBox = forwardRef(function SearchBox({ initialQ, onSearch, size = "compact", autoFocus = false }, inputRef) {
  const [q, setQ] = useState(initialQ);
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1); // highlighted suggestion, -1 = none
  const [typing, setTyping] = useState(false); // only the user's own typing asks for suggestions
  const listId = `suggestions-${size}`;

  // When the URL changes (Back button, logo click), show its query.
  useEffect(() => {
    setQ(initialQ);
    setTyping(false);
    setOpen(false);
  }, [initialQ]);

  // Debounced suggestions. Each new keystroke clears the timer and cancels
  // the previous request, so a slow old answer can't replace a newer one.
  useEffect(() => {
    if (!typing || !q.trim()) {
      setSuggestions([]);
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      suggestApi(q.trim(), controller.signal)
        .then((list) => {
          setSuggestions(list);
          setActive(-1);
          setOpen(list.length > 0);
        })
        .catch(() => {}); // aborted or offline: just no suggestions
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q, typing]);

  function run(text) {
    setTyping(false);
    setOpen(false);
    if (text.trim()) onSearch(text.trim());
  }

  function choose(suggestion) {
    setQ(suggestion.text);
    run(suggestion.text);
  }

  function clear() {
    setQ("");
    setTyping(false);
    setOpen(false);
    inputRef?.current?.focus();
  }

  function onKeyDown(event) {
    if (event.key === "Escape") {
      // First Escape closes the list, the next one clears the box.
      if (open) setOpen(false);
      else if (q) clear();
      return;
    }
    if (!open || suggestions.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => (i + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (event.key === "Enter" && active >= 0) {
      event.preventDefault(); // choose the highlighted suggestion instead of submitting the text
      choose(suggestions[active]);
    }
  }

  return (
    <form className={`searchbox searchbox--${size}`} onSubmit={(e) => (e.preventDefault(), run(q))} role="search">
      <div className="searchbox__field">
        <span className="searchbox__icon" aria-hidden="true">
          <SearchIcon />
        </span>
        <input
          ref={inputRef}
          className="searchbox__input"
          type="search"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setTyping(true);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setOpen(false)}
          onFocus={() => setOpen(typing && suggestions.length > 0)}
          placeholder={size === "large" ? "Search Wikipedia and Medium…" : "Search…"}
          aria-label="Search"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          maxLength={200}
          autoFocus={autoFocus}
        />
        {q && (
          <button type="button" className="iconbtn searchbox__clear" onClick={clear} aria-label="Clear the search box">
            <CloseIcon />
          </button>
        )}
        {size === "large" && !q && (
          <kbd className="kbd" title="Press / to focus the search box">
            /
          </kbd>
        )}
        {size === "large" ? (
          <button className="searchbox__go" type="submit" aria-label="Search">
            <ArrowIcon />
          </button>
        ) : (
          <button className="searchbox__submit" type="submit">
            Search
          </button>
        )}
        {open && (
          <ul className="suggestions" id={listId} role="listbox">
            {suggestions.map((s, i) => (
              <li
                key={s.text}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={i === active ? "is-active" : undefined}
                // mousedown, not click: click would come after the input's blur closed the list
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(s);
                }}
                onMouseEnter={() => setActive(i)}
              >
                <SearchIcon />
                <span>
                  <Highlighted text={s.text} typed={q} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </form>
  );
});

export default SearchBox;
