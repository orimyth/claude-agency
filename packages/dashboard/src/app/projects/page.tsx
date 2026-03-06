"use client";

import { useState, useEffect } from "react";
import { fetchProjects } from "@/lib/api";

interface Project {
  id: string;
  name: string;
  description: string;
  status: "active" | "paused" | "completed";
  taskCount: number;
  taskCounts: {
    backlog: number;
    assigned: number;
    in_progress: number;
    review: number;
    done: number;
    blocked: number;
  };
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);

  useEffect(() => {
    fetchProjects()
      .then((data) => setProjects(Array.isArray(data) ? data : []))
      .catch(() => {});

    const interval = setInterval(() => {
      fetchProjects()
        .then((data) => setProjects(Array.isArray(data) ? data : []))
        .catch(() => {});
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="max-w-6xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Projects</h1>

      {projects.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-12 text-center">
          <p className="text-gray-400 text-lg">No projects yet</p>
          <p className="text-gray-300 text-sm mt-2">
            Projects are created when the CEO decides an idea needs a dedicated workspace.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {projects.map((project) => {
            const total = project.taskCount;
            const done = project.taskCounts?.done ?? 0;
            const progress = total > 0 ? Math.round((done / total) * 100) : 0;

            return (
              <div
                key={project.id}
                className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 hover:shadow-md transition-shadow"
              >
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-semibold text-gray-900">{project.name}</h3>
                  <span
                    className={`px-2 py-0.5 rounded text-xs font-medium ${
                      project.status === "active"
                        ? "bg-green-100 text-green-700"
                        : project.status === "paused"
                        ? "bg-yellow-100 text-yellow-700"
                        : "bg-gray-100 text-gray-600"
                    }`}
                  >
                    {project.status}
                  </span>
                </div>
                <p className="text-sm text-gray-500 mb-4">{project.description}</p>

                {total > 0 && (
                  <>
                    <div className="mb-2">
                      <div className="flex justify-between text-xs text-gray-400 mb-1">
                        <span>{done}/{total} tasks</span>
                        <span>{progress}%</span>
                      </div>
                      <div className="w-full bg-gray-100 rounded-full h-2">
                        <div
                          className="bg-blue-500 h-2 rounded-full transition-all"
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2 mt-3">
                      {project.taskCounts.in_progress > 0 && (
                        <span className="px-2 py-0.5 bg-blue-50 text-blue-600 rounded text-xs">
                          {project.taskCounts.in_progress} in progress
                        </span>
                      )}
                      {project.taskCounts.review > 0 && (
                        <span className="px-2 py-0.5 bg-purple-50 text-purple-600 rounded text-xs">
                          {project.taskCounts.review} in review
                        </span>
                      )}
                      {project.taskCounts.assigned > 0 && (
                        <span className="px-2 py-0.5 bg-yellow-50 text-yellow-600 rounded text-xs">
                          {project.taskCounts.assigned} assigned
                        </span>
                      )}
                      {project.taskCounts.backlog > 0 && (
                        <span className="px-2 py-0.5 bg-gray-50 text-gray-500 rounded text-xs">
                          {project.taskCounts.backlog} backlog
                        </span>
                      )}
                      {project.taskCounts.blocked > 0 && (
                        <span className="px-2 py-0.5 bg-red-50 text-red-600 rounded text-xs">
                          {project.taskCounts.blocked} blocked
                        </span>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
