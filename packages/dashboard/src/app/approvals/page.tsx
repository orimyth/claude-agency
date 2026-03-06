"use client";

import { useState, useEffect } from "react";
import { fetchApprovals, resolveApproval, type Approval } from "@/lib/api";

export default function ApprovalsPage() {
  const [approvals, setApprovals] = useState<Approval[]>([]);

  useEffect(() => {
    fetchApprovals()
      .then((data) => setApprovals(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, []);

  async function handleResolve(id: string, status: "approved" | "rejected") {
    try {
      await resolveApproval(id, status);
      setApprovals((prev) =>
        prev.map((a) => (a.id === id ? { ...a, status } : a))
      );
    } catch {
      setApprovals((prev) =>
        prev.map((a) => (a.id === id ? { ...a, status } : a))
      );
    }
  }

  const pending = approvals.filter((a) => a.status === "pending");
  const resolved = approvals.filter((a) => a.status !== "pending");

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Approval Queue</h1>

      {pending.length === 0 && resolved.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-12 text-center">
          <p className="text-gray-400 text-lg">No approvals yet</p>
          <p className="text-gray-300 text-sm mt-2">
            When the CEO or Architect needs your sign-off, it will appear here.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {pending.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
                Pending ({pending.length})
              </h2>
              <div className="space-y-3">
                {pending.map((approval) => (
                  <div
                    key={approval.id}
                    className="bg-white rounded-xl shadow-sm border-l-4 border-yellow-400 p-6"
                  >
                    <h3 className="font-semibold text-gray-900">{approval.title}</h3>
                    <p className="text-sm text-gray-600 mt-2 whitespace-pre-wrap">
                      {approval.description}
                    </p>
                    <div className="flex items-center justify-between mt-4">
                      <p className="text-xs text-gray-400">
                        By {approval.requestedBy || approval.requested_by} — {new Date(approval.createdAt || approval.created_at || "").toLocaleString()}
                      </p>
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleResolve(approval.id, "approved")}
                          className="px-4 py-1.5 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700"
                        >
                          Approve
                        </button>
                        <button
                          onClick={() => handleResolve(approval.id, "rejected")}
                          className="px-4 py-1.5 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700"
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
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
                Resolved ({resolved.length})
              </h2>
              <div className="space-y-2">
                {resolved.map((approval) => (
                  <div
                    key={approval.id}
                    className={`bg-white rounded-xl shadow-sm border-l-4 p-4 opacity-70 ${
                      approval.status === "approved" ? "border-green-400" : "border-red-400"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <h3 className="font-medium text-gray-700">{approval.title}</h3>
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-medium ${
                          approval.status === "approved"
                            ? "bg-green-100 text-green-700"
                            : "bg-red-100 text-red-700"
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
