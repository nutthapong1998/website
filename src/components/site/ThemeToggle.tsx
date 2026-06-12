"use client";

import { useEffect, useState } from "react";

export function ThemeToggle() {
  // Dark is the SSR default; sync with whatever the inline boot script set
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  useEffect(() => {
    if (document.documentElement.dataset.theme === "light") setTheme("light");
  }, []);

  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    if (next === "light") {
      document.documentElement.dataset.theme = "light";
    } else {
      delete document.documentElement.dataset.theme;
    }
    try {
      localStorage.setItem("theme", next);
    } catch {
      // private mode — toggle still works for this page view
    }
    setTheme(next);
  }

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      aria-label={
        theme === "dark" ? "Switch to light theme" : "Switch to dark theme"
      }
    >
      {theme === "dark" ? (
        // sun — clicking switches to light
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4m11.4-11.4 1.4-1.4" />
        </svg>
      ) : (
        // moon — clicking switches to dark
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
        </svg>
      )}
    </button>
  );
}
