"use client";

import { useState, useEffect } from "react";
import { useGlobalWS } from "@/components/ws-provider";
import { fetchApprovals, resolveApproval, type Approval } from "@/lib/api";

function timeAgo(dateStr: string | null | undefined): string {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86400_000)}d ago`;
}

export default function ApprovalsPage() {
  const { on } = useGlobalWS();
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  useEffect(() => {
    fetchApprovals()
      .then((data) => setApprovals(Array.isArray(data) ? data : []))
      .catch(() => {})
      .finally(() => setLoading(false));

    const interval = setInterval(() => {
      fetchApprovals().then((data) => { if (Array.isArray(data)) setApprovals(data); }).catch(() => {});
    }, 15000);
    return () => clearInterval(interval);
  }, []);

  // Real-time approval updates
  useEffect(() => {
    const unsub1 = on("approval:new", (data) => {
      setApprovals((prev) => {
        if (prev.find((a) => a.id === data.id)) return prev;
        return [{
          id: data.id,
          title: data.title,
          description: data.description || "",
          requestedBy: data.requestedBy || data.agentId,
          status: "pending",
          projectId: data.projectId || null,
          createdAt: new Date().toISOString(),
        }, ...prev];
      });
    });
    const unsub2 = on("approval:resolved", (data) => {
      setApprovals((prev) =>
        prev.map((a) => (a.id === data.id ? { ...a, status: data.status } : a))
      );
    });
    return () => { unsub1(); unsub2(); };
  }, [on]);

  async function handleResolve(id: string, status: "approved" | "rejected") {
    setActionLoading(id);
    try {
      await resolveApproval(id, status, feedback[id]);
      setApprovals((prev) =>
        prev.map((a) => (a.id === id ? { ...a, status } : a))
      );
      setFeedback((prev) => { const next = { ...prev }; delete next[id]; return next; });
    } catch {
      setApprovals((prev) =>
        prev.map((a) => (a.id === id ? { ...a, status } : a))
      );
    } finally {
      setActionLoading(null);
    }
  }

  const pending = approvals.filter((a) => a.status === "pending");
  const resolved = approvals.filter((a) => a.status !== "pending");

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-6">Approval Queue</h1>
        <div className="animate-pulse space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-32 bg-gray-100 dark:bg-gray-800 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Approval Queue</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {pending.length} pending, {resolved.length} resolved
          </p>
        </div>
        {pending.length > 0 && (
          <span className="px-3 py-1 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 rounded-full text-sm font-medium">
            {pending.length} awaiting review
          </span>
        )}
      </div>

      {pending.length === 0 && resolved.length === 0 ? (
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-800 p-12 text-center">
          <svg className="w-12 h-12 text-gray-300 dark:text-gray-600 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-gray-400 dark:text-gray-500 text-lg">No approvals yet</p>
          <p className="text-gray-300 dark:text-gray-600 text-sm mt-2">
            When the CEO or Architect needs your sign-off, it will appear here.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {pending.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">
                Pending ({pending.length})
              </h2>
              <div className="space-y-3">
                {pending.map((approval) => (
                  <div
                    key={approval.id}
                    className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-800 border-l-4 border-l-amber-400 p-6"
                  >
                    <h3 className="font-semibold text-gray-900 dark:text-white">{approval.title}</h3>
                    <p className="text-sm text-gray-600 dark:text-gray-400 mt-2 whitespace-pre-wrap leading-relaxed">
                      {approval.description}
                    </p>

                    {/* Feedback input */}
                    <div className="mt-4">
                      <input
                        type="text"
                        placeholder="Add feedback (optional)..."
                        value={feedback[approval.id] || ""}
                        onChange={(e) => setFeedback((prev) => ({ ...prev, [approval.id]: e.target.value }))}
                        className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      />
                    </div>

                    <div className="flex items-center justify-between mt-4">
                      <p className="text-xs text-gray-400 dark:text-gray-500">
                        By {approval.requestedBy || approval.requested_by}
                        {" — "}
                        {timeAgo(approval.createdAt || approval.created_at)}
                      </p>
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleResolve(approval.id, "approved")}
                          disabled={actionLoading === approval.id}
                          className="px-4 py-1.5 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 transition-colors"
                        >
                          {actionLoading === approval.id ? "..." : "Approve"}
                        </button>
                        <button
                          onClick={() => handleResolve(approval.id, "rejected")}
                          disabled={actionLoading === approval.id}
                          className="px-4 py-1.5 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50 transition-colors"
                        >
                          Reject
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {resolved.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">
                Resolved ({resolved.length})
              </h2>
              <div className="space-y-2">
                {resolved.map((approval) => (
                  <div
                    key={approval.id}
                    className={`bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-800 border-l-4 p-4 ${
                      approval.status === "approved"
                        ? "border-l-emerald-400"
                        : "border-l-red-400"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex-1 min-w-0">
                        <h3 className="font-medium text-gray-700 dark:text-gray-300 truncate">{approval.title}</h3>
                        <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                          By {approval.requestedBy || approval.requested_by}
                          {" — "}
                          {timeAgo(approval.createdAt || approval.created_at)}
                        </p>
                      </div>
                      <span
                        className={`ml-3 px-2.5 py-1 rounded-full text-xs font-medium ${
                          approval.status === "approved"
                            ? "bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400"
                            : "bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400"
                        }`}
                      >
                        {approval.status}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
