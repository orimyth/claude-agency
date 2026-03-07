"use client";

import {
  createContext,
  useContext,
  useCallback,
  useState,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { fetchAgents, fetchTasks, fetchProjects } from "@/lib/api";
import type { Agent, Task, Project } from "@/lib/api";
import { agentStyle, taskStyle, projectStyle } from "@/lib/status-colors";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CommandItem {
  id: string;
  category: "page" | "agent" | "task" | "project";
  label: string;
  sublabel?: string;
  icon?: ReactNode;
  action: () => void;
}

interface CommandPaletteContextValue {
  open: () => void;
}

const CommandPaletteContext = createContext<CommandPaletteContextValue>({
  open: () => {},
});

export function useCommandPalette() {
  return useContext(CommandPaletteContext);
}

// ---------------------------------------------------------------------------
// Fuzzy match
// ---------------------------------------------------------------------------

function fuzzyMatch(query: string, text: string): { match: boolean; score: number } {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return { match: true, score: 0 };
  if (t.includes(q)) return { match: true, score: 100 - t.indexOf(q) };

  let qi = 0;
  let score = 0;
  let lastMatchIdx = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += 10;
      if (lastMatchIdx === ti - 1) score += 5; // consecutive bonus
      lastMatchIdx = ti;
      qi++;
    }
  }
  return { match: qi === q.length, score };
}

// ---------------------------------------------------------------------------
// Highlight matched characters
// ---------------------------------------------------------------------------

function HighlightMatch({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  // Simple substring highlight
  const idx = t.indexOf(q);
  if (idx >= 0) {
    return (
      <>
        {text.slice(0, idx)}
        <span className="text-blue-600 font-semibold">{text.slice(idx, idx + q.length)}</span>
        {text.slice(idx + q.length)}
      </>
    );
  }

  // Fuzzy highlight
  const chars = text.split("");
  let qi = 0;
  const highlighted = chars.map((ch, i) => {
    if (qi < q.length && ch.toLowerCase() === q[qi]) {
      qi++;
      return (
        <span key={i} className="text-blue-600 font-semibold">
          {ch}
        </span>
      );
    }
    return <span key={i}>{ch}</span>;
  });
  return <>{highlighted}</>;
}

// ---------------------------------------------------------------------------
// Page definitions
// ---------------------------------------------------------------------------

const PAGES: { label: string; path: string; icon: string }[] = [
  { label: "Dashboard", path: "/", icon: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" },
  { label: "Agents", path: "/agents", icon: "M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" },
  { label: "The Office", path: "/office", icon: "M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" },
  { label: "Timeline", path: "/timeline", icon: "M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" },
  { label: "Projects", path: "/projects", icon: "M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" },
  { label: "Approvals", path: "/approvals", icon: "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" },
  { label: "Usage & Costs", path: "/usage", icon: "M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" },
  { label: "Settings", path: "/settings", icon: "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" },
];

// ---------------------------------------------------------------------------
// Status dot component
// ---------------------------------------------------------------------------

function StatusDot({ color }: { color: string }) {
  return <span className={`w-2 h-2 rounded-full flex-shrink-0 ${color}`} />;
}

// ---------------------------------------------------------------------------
// Command Palette Provider
// ---------------------------------------------------------------------------

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [items, setItems] = useState<CommandItem[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  const open = useCallback(() => {
    setIsOpen(true);
    setQuery("");
    setActiveIndex(0);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    setQuery("");
  }, []);

  // Global keyboard shortcut
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setIsOpen((prev) => !prev);
        setQuery("");
        setActiveIndex(0);
      }
      if (e.key === "Escape" && isOpen) {
        close();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, close]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Load data when opened
  useEffect(() => {
    if (!isOpen) return;

    const buildItems = async () => {
      const allItems: CommandItem[] = [];

      // Pages
      PAGES.forEach((page) => {
        allItems.push({
          id: `page-${page.path}`,
          category: "page",
          label: page.label,
          sublabel: `Go to ${page.label}`,
          icon: (
            <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={page.icon} />
            </svg>
          ),
          action: () => {
            router.push(page.path);
            close();
          },
        });
      });

      // Agents
      try {
        const agents = await fetchAgents();
        if (Array.isArray(agents)) {
          agents.forEach((agent: Agent) => {
            const style = agentStyle(agent.status);
            allItems.push({
              id: `agent-${agent.id}`,
              category: "agent",
              label: agent.name,
              sublabel: `${agent.role} — ${style.label}`,
              icon: <StatusDot color={style.dot} />,
              action: () => {
                router.push("/agents");
                close();
              },
            });
          });
        }
      } catch {}

      // Tasks
      try {
        const tasks = await fetchTasks();
        if (Array.isArray(tasks)) {
          tasks.forEach((task: Task) => {
            const style = taskStyle(task.status);
            allItems.push({
              id: `task-${task.id}`,
              category: "task",
              label: task.title || task.id,
              sublabel: `${style.label}${task.assignedTo ? ` — ${task.assignedTo}` : ""}`,
              icon: <StatusDot color={style.dot} />,
              action: () => {
                router.push("/");
                close();
              },
            });
          });
        }
      } catch {}

      // Projects
      try {
        const projects = await fetchProjects();
        if (Array.isArray(projects)) {
          projects.forEach((project: Project) => {
            const style = projectStyle(project.status);
            allItems.push({
              id: `project-${project.id}`,
              category: "project",
              label: project.name,
              sublabel: `${style.label}${project.taskCount ? ` — ${project.taskCount} tasks` : ""}`,
              icon: <StatusDot color={style.dot} />,
              action: () => {
                router.push("/projects");
                close();
              },
            });
          });
        }
      } catch {}

      setItems(allItems);
    };

    buildItems();
  }, [isOpen, router, close]);

  // Filter and sort results
  const filtered = query
    ? items
        .map((item) => {
          const labelMatch = fuzzyMatch(query, item.label);
          const subMatch = item.sublabel ? fuzzyMatch(query, item.sublabel) : { match: false, score: 0 };
          const best = labelMatch.score >= subMatch.score ? labelMatch : subMatch;
          return { item, ...best };
        })
        .filter((r) => r.match)
        .sort((a, b) => b.score - a.score)
        .map((r) => r.item)
    : items;

  // Group by category
  const grouped: { category: string; label: string; items: CommandItem[] }[] = [];
  const categoryOrder: { key: CommandItem["category"]; label: string }[] = [
    { key: "page", label: "Pages" },
    { key: "agent", label: "Agents" },
    { key: "project", label: "Projects" },
    { key: "task", label: "Tasks" },
  ];

  for (const cat of categoryOrder) {
    const catItems = filtered.filter((i) => i.category === cat.key);
    if (catItems.length > 0) {
      // Limit tasks to 8 when no query to avoid overwhelming the list
      const limited = !query && cat.key === "task" ? catItems.slice(0, 8) : catItems;
      grouped.push({ category: cat.key, label: cat.label, items: limited });
    }
  }

  const flatFiltered = grouped.flatMap((g) => g.items);

  // Keep activeIndex in bounds
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((prev) => Math.min(prev + 1, flatFiltered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter" && flatFiltered[activeIndex]) {
      e.preventDefault();
      flatFiltered[activeIndex].action();
    }
  };

  // Scroll active item into view
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (!isOpen) {
    return (
      <CommandPaletteContext.Provider value={{ open }}>
        {children}
      </CommandPaletteContext.Provider>
    );
  }

  let flatIndex = -1;

  return (
    <CommandPaletteContext.Provider value={{ open }}>
      {children}

      {/* Backdrop */}
      <div
        className="fixed inset-0 z-[60] bg-black/40 backdrop-blur-sm"
        onClick={close}
        style={{ animation: "cmdFadeIn 0.15s ease-out" }}
      />

      {/* Palette */}
      <div
        className="fixed inset-0 z-[61] flex items-start justify-center pt-[15vh] px-4"
        onClick={close}
      >
        <div
          className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 w-full max-w-lg overflow-hidden"
          onClick={(e) => e.stopPropagation()}
          style={{ animation: "cmdScaleIn 0.2s cubic-bezier(0.16, 1, 0.3, 1)" }}
        >
          {/* Search input */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 dark:border-gray-800">
            <svg className="w-5 h-5 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search agents, tasks, projects, pages..."
              className="flex-1 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 outline-none bg-transparent"
            />
            <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 rounded border border-gray-200 bg-gray-50 text-xs text-gray-400 font-mono">
              esc
            </kbd>
          </div>

          {/* Results */}
          <div ref={listRef} className="max-h-[50vh] overflow-y-auto py-2">
            {flatFiltered.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <p className="text-sm text-gray-400">No results for &ldquo;{query}&rdquo;</p>
              </div>
            ) : (
              grouped.map((group) => (
                <div key={group.category}>
                  <div className="px-4 pt-2 pb-1">
                    <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">
                      {group.label}
                    </p>
                  </div>
                  {group.items.map((item) => {
                    flatIndex++;
                    const idx = flatIndex;
                    const isActive = idx === activeIndex;
                    return (
                      <button
                        key={item.id}
                        data-index={idx}
                        onClick={() => item.action()}
                        onMouseEnter={() => setActiveIndex(idx)}
                        className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                          isActive ? "bg-blue-50 dark:bg-blue-900/30" : "hover:bg-gray-50 dark:hover:bg-gray-800"
                        }`}
                      >
                        <div className="flex-shrink-0 w-6 h-6 flex items-center justify-center">
                          {item.icon}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className={`text-sm truncate ${isActive ? "text-blue-700 dark:text-blue-400 font-medium" : "text-gray-900 dark:text-gray-200"}`}>
                            <HighlightMatch text={item.label} query={query} />
                          </p>
                          {item.sublabel && (
                            <p className="text-xs text-gray-400 truncate">{item.sublabel}</p>
                          )}
                        </div>
                        {isActive && (
                          <span className="flex-shrink-0 text-xs text-blue-400">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                            </svg>
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center gap-4 px-4 py-2 border-t border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/50 text-xs text-gray-400">
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 rounded border border-gray-200 bg-white font-mono text-[10px]">&uarr;</kbd>
              <kbd className="px-1 py-0.5 rounded border border-gray-200 bg-white font-mono text-[10px]">&darr;</kbd>
              navigate
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1.5 py-0.5 rounded border border-gray-200 bg-white font-mono text-[10px]">&crarr;</kbd>
              select
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1.5 py-0.5 rounded border border-gray-200 bg-white font-mono text-[10px]">esc</kbd>
              close
            </span>
          </div>
        </div>
      </div>
    </CommandPaletteContext.Provider>
  );
}
