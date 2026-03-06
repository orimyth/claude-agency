"use client";

import { useState, useEffect } from "react";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3002";

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
    fetch(`${API}/api/settings`)
      .then((r) => r.json())
      .then((settings: Record<string, string>) => {
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
        headers: { "Content-Type": "application/json" },
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

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
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
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h2 className="font-semibold text-gray-900 mb-1">
          Agent Language
        </h2>
        <p className="text-sm text-gray-500 mb-4">
          The language all agents use when communicating in Slack and reports.
          &quot;Auto-detect&quot; means agents mirror whatever language you write in.
        </p>
        <select
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          className="w-full max-w-md px-4 py-2.5 border border-gray-200 rounded-lg text-sm bg-white text-gray-900"
        >
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </div>

      {/* Concurrency */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h2 className="font-semibold text-gray-900 mb-1">
          Max Concurrent Agents
        </h2>
        <p className="text-sm text-gray-500 mb-4">
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
            className="flex-1 max-w-xs"
          />
          <span className="text-lg font-mono font-semibold text-gray-900 w-8 text-center">
            {maxConcurrency}
          </span>
        </div>
        <div className="bg-gray-50 rounded-lg p-4 text-xs text-gray-600 space-y-1.5">
          <p className="font-semibold text-gray-700">Resource usage per agent:</p>
          <p>
            Each active agent runs a Claude Code session (~100K-200K tokens per
            complex task, ~10K-30K for simple tasks).
          </p>
          <p>
            Idle agents consume zero tokens — they only use resources when
            assigned a task.
          </p>
          <p>
            Rate-limited agents auto-pause for ~5 min. Higher concurrency =
            faster work but more API cost and higher chance of hitting rate
            limits.
          </p>
          <div className="mt-2 pt-2 border-t border-gray-200">
            <p className="font-semibold text-gray-700">Recommendations:</p>
            <p>1-2 agents: Low cost, good for small tasks</p>
            <p>3-5 agents: Balanced — good for most projects</p>
            <p>6-10 agents: Fast parallel execution, higher API cost</p>
          </div>
        </div>
      </div>

      {/* Blacklist */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h2 className="font-semibold text-gray-900 mb-1">
          Global Blacklist
        </h2>
        <p className="text-sm text-gray-500 mb-4">
          Commands that no agent is allowed to run, regardless of role.
        </p>

        <div className="flex gap-2 mb-4">
          <input
            type="text"
            value={blacklistInput}
            onChange={(e) => setBlacklistInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addToBlacklist()}
            placeholder="Add a blocked command..."
            className="flex-1 px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-900"
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
              className="inline-flex items-center gap-1 px-3 py-1 bg-red-50 text-red-700 rounded-full text-xs font-mono"
            >
              {item}
              <button
                onClick={() => removeFromBlacklist(item)}
                className="ml-1 text-red-400 hover:text-red-600"
              >
                x
              </button>
            </span>
          ))}
        </div>
      </div>

      {/* Connection info */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h2 className="font-semibold text-gray-900 mb-4">Connection</h2>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-500">API</span>
            <span className="font-mono text-gray-700">{API}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">WebSocket</span>
            <span className="font-mono text-gray-700">ws://localhost:3001</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">MySQL</span>
            <span className="font-mono text-gray-700">localhost:3306</span>
          </div>
        </div>
      </div>
    </div>
  );
}
