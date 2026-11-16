// Small line icons (24x24 grid, 1.75 stroke), drawn inline so they take the
// text color and need no icon library.

const Svg = ({ size = 16, children }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const SearchIcon = ({ size }) => (
  <Svg size={size}>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </Svg>
);
export const CloseIcon = ({ size = 14 }) => (
  <Svg size={size}>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </Svg>
);
export const ArrowIcon = ({ size = 16 }) => (
  <Svg size={size}>
    <path d="M5 12h14" />
    <path d="m12 5 7 7-7 7" />
  </Svg>
);
export const SunIcon = () => (
  <Svg>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2m-7.07-17.07 1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
  </Svg>
);
export const MoonIcon = () => (
  <Svg>
    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
  </Svg>
);
export const SlidersIcon = () => (
  <Svg>
    <path d="M4 21h16M4 14h16M4 7h16" />
    <circle cx="9" cy="7" r="2" />
    <circle cx="15" cy="14" r="2" />
    <circle cx="11" cy="21" r="2" />
  </Svg>
);
export const TrendIcon = () => (
  <Svg>
    <path d="m22 7-8.5 8.5-5-5L2 17" />
    <path d="M16 7h6v6" />
  </Svg>
);

/** The brand mark: a magnifier in a rounded square. */
export const Monogram = ({ size = 28 }) => (
  <span className="monogram" style={{ width: size, height: size }} aria-hidden="true">
    <svg width={size / 2} height={size / 2} viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="5" stroke="currentColor" strokeWidth="1.75" />
      <path d="M11.5 11.5L14 14" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  </span>
);
