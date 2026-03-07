"use client";

import { useState, useEffect, useCallback } from "react";
import { fetchEmergencyStatus, emergencyPause, emergencyResume } from "@/lib/api";

export function EmergencyBanner() {
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const checkStatus = useCallback(() => {
    fetchEmergencyStatus().then((s) => setPaused(s.paused)).catch(() => {});
  }, []);

  useEffect(() => {
    checkStatus();
    const interval = setInterval(checkStatus, 10000);
    return () => clearInterval(interval);
  }, [checkStatus]);

  const handlePause = async () => {
    setLoading(true);
    try {
      await emergencyPause();
      setPaused(true);
      setShowConfirm(false);
    } finally {
      setLoading(false);
    }
  };

  const handleResume = async () => {
    setLoading(true);
    try {
      await emergencyResume();
      setPaused(false);
    } finally {
      setLoading(false);
    }
  };

  if (paused) {
    return (
      <div className="bg-red-600 text-white px-4 py-2.5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <svg className="w-5 h-5 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
          <span className="text-sm font-semibold">EMERGENCY PAUSE ACTIVE</span>
          <span className="text-sm opacity-80">— All agents are stopped</span>
        </div>
        <button
          onClick={handleResume}
          disabled={loading}
          className="px-4 py-1 text-sm font-medium rounded-lg bg-white text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
        >
          {loading ? "Resuming..." : "Resume Operations"}
        </button>
      </div>
    );
  }

  return (
    <div className="flex justify-end px-4 py-1.5 bg-gray-50 dark:bg-gray-900 border-b border-gray-100 dark:border-gray-800">
      {!showConfirm ? (
        <button
          onClick={() => setShowConfirm(true)}
          className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-lg text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 border border-red-200 dark:border-red-800 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          Emergency Stop
        </button>
      ) : (
        <div className="flex items-center gap-2">
          <span className="text-xs text-red-600 dark:text-red-400 font-medium">Stop all agents?</span>
          <button
            onClick={handlePause}
            disabled={loading}
            className="px-3 py-1 text-xs font-medium rounded-lg bg-red-600 text-white hover:bg-red-700 transition-colors disabled:opacity-50"
          >
            {loading ? "Stopping..." : "Yes, Stop All"}
          </button>
          <button
            onClick={() => setShowConfirm(false)}
            className="px-3 py-1 text-xs font-medium rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
