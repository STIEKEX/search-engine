import { useCallback, useRef, useState } from "react";

// Small confirmations ("Preference saved") in the corner, instead of alert().
// role="status" makes screen readers announce them without moving focus.

export function useToasts() {
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(0);
  const show = useCallback((text) => {
    const id = nextId.current++;
    setToasts((list) => [...list, { id, text }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 2200);
  }, []);
  return [toasts, show];
}

export function Toasts({ toasts }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          {t.text}
        </div>
      ))}
    </div>
  );
}
