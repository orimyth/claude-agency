"use client";

import { createContext, useContext, useCallback, useState, useEffect, type ReactNode } from "react";

type Theme = "light" | "dark" | "system";

interface ThemeContextValue {
  theme: Theme;
  resolved: "light" | "dark";
  setTheme: (theme: Theme) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "system",
  resolved: "light",
  setTheme: () => {},
  toggle: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

function getSystemTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function resolveTheme(theme: Theme): "light" | "dark" {
  if (theme === "system") return getSystemTheme();
  return theme;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("system");
  const [resolved, setResolved] = useState<"light" | "dark">("light");

  // Initialize from localStorage
  useEffect(() => {
    const stored = localStorage.getItem("theme") as Theme | null;
    const initial = stored ?? "system";
    setThemeState(initial);
    setResolved(resolveTheme(initial));
  }, []);

  // Apply dark class to <html>
  useEffect(() => {
    const root = document.documentElement;
    if (resolved === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
  }, [resolved]);

  // Listen for system theme changes
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (theme === "system") {
        setResolved(getSystemTheme());
      }
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    setResolved(resolveTheme(t));
    localStorage.setItem("theme", t);
  }, []);

  const toggle = useCallback(() => {
    const next = resolved === "light" ? "dark" : "light";
    setTheme(next);
  }, [resolved, setTheme]);

  return (
    <ThemeContext.Provider value={{ theme, resolved, setTheme, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}
