"use client";

/**
 * The light and dark switch. A single round button that swaps a sun for a moon,
 * with the icon doing a small rotate-and-fade so the change feels deliberate
 * rather than instant. Nothing here decides the theme; it just calls the toggle
 * the provider owns.
 */

import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/providers/ThemeProvider";

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const isDark = theme === "dark";

  return (
    <button
      className="theme-toggle"
      onClick={toggle}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Light mode" : "Dark mode"}
    >
      <span className={`theme-toggle-icon ${isDark ? "is-dark" : "is-light"}`}>
        {isDark ? <Moon size={18} /> : <Sun size={18} />}
      </span>
    </button>
  );
}
