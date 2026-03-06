"use client";

import { useState } from "react";

export default function SettingsPage() {
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
      <h1 className="text-2xl font-bold text-gray-900">Settings</h1>

      {/* Concurrency */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h2 className="font-semibold text-gray-900 mb-4">Concurrency</h2>
        <div className="flex items-center gap-4">
          <label className="text-sm text-gray-600">Max concurrent agents:</label>
          <input
            type="number"
            min={1}
            max={20}
            value={maxConcurrency}
            onChange={(e) => setMaxConcurrency(Number(e.target.value))}
            className="w-20 px-3 py-1.5 border border-gray-200 rounded-lg text-sm"
          />
        </div>
        <p className="text-xs text-gray-400 mt-2">
          How many agents can work simultaneously. Higher = more API usage.
        </p>
      </div>

      {/* Blacklist */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h2 className="font-semibold text-gray-900 mb-4">Global Blacklist</h2>
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
            className="flex-1 px-4 py-2 border border-gray-200 rounded-lg text-sm"
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
            <span className="text-gray-500">WebSocket</span>
            <span className="font-mono text-gray-700">ws://localhost:3001</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">MySQL</span>
            <span className="font-mono text-gray-700">localhost:3306</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Slack</span>
            <span className="text-gray-400">Not configured</span>
          </div>
        </div>
      </div>
    </div>
  );
}
