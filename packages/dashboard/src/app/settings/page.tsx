"use client";

import { useState, useEffect } from "react";
import { fetchSettings } from "@/lib/api";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3002";
const API_KEY = process.env.NEXT_PUBLIC_API_KEY || "";

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  if (API_KEY) h["Authorization"] = `Bearer ${API_KEY}`;
  return h;
}

const LANGUAGES = [
  { code: "auto", label: "Auto-detect (match investor's language)" },
  { code: "English", label: "English" },
  { code: "German", label: "Deutsch (German)" },
  { code: "French", label: "Francais (French)" },
  { code: "Spanish", label: "Espanol (Spanish)" },
  { code: "Italian", label: "Italiano (Italian)" },
  { code: "Portuguese", label: "Portugues (Portuguese)" },
  { code: "Dutch", label: "Nederlands (Dutch)" },
  { code: "Japanese", label: "Japanese" },
  { code: "Chinese", label: "Chinese" },
  { code: "Korean", label: "Korean" },
];

export default function SettingsPage() {
  const [language, setLanguage] = useState("auto");
  const [maxConcurrency, setMaxConcurrency] = useState(5);
  const [blacklistInput, setBlacklistInput] = useState("");
  const [blacklist, setBlacklist] = useState<string[]>([
    "rm -rf /",
    "rm -rf ~",
    "git push --force origin main",
    "DROP DATABASE",
    "DROP TABLE",
    "shutdown",
    "reboot",
  ]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetchSettings()
      .then((settings) => {
        if (settings.language) setLanguage(settings.language);
        if (settings.maxConcurrency)
          setMaxConcurrency(parseInt(settings.maxConcurrency, 10));
        if (settings.blacklist) {
          try {
            setBlacklist(JSON.parse(settings.blacklist));
          } catch {}
        }
      })
      .catch(() => {});
  }, []);

  async function saveSettings() {
    setSaving(true);
    try {
      await fetch(`${API}/api/settings`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          language,
          maxConcurrency: String(maxConcurrency),
          blacklist: JSON.stringify(blacklist),
        }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      console.error("Failed to save settings:", err);
    } finally {
      setSaving(false);
    }
  }

  function addToBlacklist() {
    if (blacklistInput.trim() && !blacklist.includes(blacklistInput.trim())) {
      setBlacklist((prev) => [...prev, blacklistInput.trim()]);
      setBlacklistInput("");
    }
  }

  function removeFromBlacklist(item: string) {
    setBlacklist((prev) => prev.filter((i) => i !== item));
  }

  const cardClass =
    "bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 p-6";

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Settings</h1>
        <button
          onClick={saveSettings}
          disabled={saving}
          className={`px-5 py-2 rounded-lg text-sm font-medium transition-colors ${
            saved
              ? "bg-green-600 text-white"
              : "bg-blue-600 text-white hover:bg-blue-700"
          } disabled:opacity-50`}
        >
          {saving ? "Saving..." : saved ? "Saved!" : "Save Settings"}
        </button>
      </div>

      {/* Language */}
      <div className={cardClass}>
        <h2 className="font-semibold text-gray-900 dark:text-white mb-1">Agent Language</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          The language all agents use when communicating in Slack and reports.
          &quot;Auto-detect&quot; means agents mirror whatever language you write in.
        </p>
        <select
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          className="w-full max-w-md px-4 py-2.5 border border-gray-200 dark:border-gray-700 rounded-lg text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
        >
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </div>

      {/* Concurrency */}
      <div className={cardClass}>
        <h2 className="font-semibold text-gray-900 dark:text-white mb-1">Max Concurrent Agents</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          How many agents can work on tasks simultaneously. Each active agent
          consumes one Claude API session and uses tokens while working.
        </p>
        <div className="flex items-center gap-4 mb-4">
          <input
            type="range"
            min={1}
            max={10}
            value={maxConcurrency}
            onChange={(e) => setMaxConcurrency(Number(e.target.value))}
            className="flex-1 max-w-xs accent-blue-600"
          />
          <span className="text-lg font-mono font-semibold text-gray-900 dark:text-white w-8 text-center">
            {maxConcurrency}
          </span>
        </div>
        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 text-xs text-gray-600 dark:text-gray-400 space-y-1.5">
          <p className="font-semibold text-gray-700 dark:text-gray-300">Resource usage per agent:</p>
          <p>Each active agent runs a Claude Code session (~100K-200K tokens per complex task).</p>
          <p>Idle agents consume zero tokens — they only use resources when assigned a task.</p>
          <p>Rate-limited agents auto-pause for ~5 min. Higher concurrency = faster work but more API cost.</p>
          <div className="mt-2 pt-2 border-t border-gray-200 dark:border-gray-700">
            <p className="font-semibold text-gray-700 dark:text-gray-300">Recommendations:</p>
            <p>1-2 agents: Low cost, good for small tasks</p>
            <p>3-5 agents: Balanced — good for most projects</p>
            <p>6-10 agents: Fast parallel execution, higher API cost</p>
          </div>
        </div>
      </div>

      {/* Blacklist */}
      <div className={cardClass}>
        <h2 className="font-semibold text-gray-900 dark:text-white mb-1">Global Blacklist</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          Commands that no agent is allowed to run, regardless of role.
        </p>
        <div className="flex gap-2 mb-4">
          <input
            type="text"
            value={blacklistInput}
            onChange={(e) => setBlacklistInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addToBlacklist()}
            placeholder="Add a blocked command..."
            className="flex-1 px-4 py-2 border border-gray-200 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-800"
          />
          <button
            onClick={addToBlacklist}
            className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700"
          >
            Block
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          {blacklist.map((item) => (
            <span
              key={item}
              className="inline-flex items-center gap-1 px-3 py-1 bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400 rounded-full text-xs font-mono"
            >
              {item}
              <button
                onClick={() => removeFromBlacklist(item)}
                className="ml-1 text-red-400 hover:text-red-600 dark:hover:text-red-300"
              >
                x
              </button>
            </span>
          ))}
        </div>
      </div>

      {/* Security */}
      <div className={cardClass}>
        <h2 className="font-semibold text-gray-900 dark:text-white mb-1">Security</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          API authentication and access control configuration.
        </p>
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between py-2 border-b border-gray-100 dark:border-gray-800">
            <div>
              <span className="text-gray-700 dark:text-gray-300 font-medium">API Key Auth</span>
              <p className="text-xs text-gray-400 mt-0.5">Set AGENCY_API_KEY env var on the orchestrator</p>
            </div>
            <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${
              API_KEY
                ? "bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400"
                : "bg-yellow-50 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400"
            }`}>
              {API_KEY ? "Enabled" : "Disabled"}
            </span>
          </div>
          <div className="flex items-center justify-between py-2 border-b border-gray-100 dark:border-gray-800">
            <div>
              <span className="text-gray-700 dark:text-gray-300 font-medium">CORS Origins</span>
              <p className="text-xs text-gray-400 mt-0.5">Set AGENCY_CORS_ORIGINS env var (comma-separated)</p>
            </div>
            <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 font-mono">
              {process.env.NEXT_PUBLIC_CORS_ORIGINS || "*"}
            </span>
          </div>
          <div className="flex items-center justify-between py-2 border-b border-gray-100 dark:border-gray-800">
            <div>
              <span className="text-gray-700 dark:text-gray-300 font-medium">Rate Limiting</span>
              <p className="text-xs text-gray-400 mt-0.5">Built-in per-IP rate limiting</p>
            </div>
            <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400">
              Active
            </span>
          </div>
          <div className="flex items-center justify-between py-2">
            <div>
              <span className="text-gray-700 dark:text-gray-300 font-medium">Permission Engine</span>
              <p className="text-xs text-gray-400 mt-0.5">Blacklist + role-based tool blocking</p>
            </div>
            <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400">
              Active
            </span>
          </div>
        </div>
      </div>

      {/* Connection info */}
      <div className={cardClass}>
        <h2 className="font-semibold text-gray-900 dark:text-white mb-4">Connection</h2>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-500 dark:text-gray-400">API</span>
            <span className="font-mono text-gray-700 dark:text-gray-300">{API}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500 dark:text-gray-400">WebSocket</span>
            <span className="font-mono text-gray-700 dark:text-gray-300">ws://localhost:3001</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500 dark:text-gray-400">MySQL</span>
            <span className="font-mono text-gray-700 dark:text-gray-300">localhost:3306</span>
          </div>
        </div>
      </div>
    </div>
  );
}
