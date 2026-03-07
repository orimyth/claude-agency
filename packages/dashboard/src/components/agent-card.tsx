import Image from "next/image";
import { agentStyle } from "@/lib/status-colors";

interface AgentCardProps {
  name: string;
  role: string;
  status: string;
  avatar?: string | null;
  currentTask?: string;
  projectId?: string;
  taskCount?: number;
  onClick?: () => void;
}

export function AgentCard({
  name,
  role,
  status,
  avatar,
  currentTask,
  projectId,
  taskCount,
  onClick,
}: AgentCardProps) {
  const style = agentStyle(status);

  return (
    <div
      onClick={onClick}
      className={`bg-white dark:bg-gray-900 rounded-xl shadow-sm p-4 hover:shadow-md transition-all duration-200 cursor-pointer border border-gray-100 dark:border-gray-800 group ${
        status === "active" ? "ring-1 ring-emerald-200 dark:ring-emerald-800" : ""
      }`}
    >
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-3">
          <div className="relative">
            {avatar ? (
              <Image
                src={avatar}
                alt={name}
                width={40}
                height={40}
                className="w-10 h-10 rounded-full object-cover"
              />
            ) : (
              <div className="w-10 h-10 bg-gradient-to-br from-gray-100 to-gray-200 dark:from-gray-700 dark:to-gray-800 rounded-full flex items-center justify-center text-lg font-bold text-gray-500 dark:text-gray-300">
                {name[0]}
              </div>
            )}
            {/* Status dot overlay */}
            <div className={`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-white dark:border-gray-900 ${style.dot}`}>
              {status === "active" && (
                <span className="absolute inset-0 rounded-full animate-ping bg-green-400 opacity-40" />
              )}
            </div>
          </div>
          <div>
            <p className="font-semibold text-gray-900 dark:text-gray-100 text-sm leading-tight">{name}</p>
            <p className="text-xs text-gray-400 dark:text-gray-500">{role}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {taskCount !== undefined && taskCount > 0 && (
            <span className="px-1.5 py-0.5 bg-blue-50 text-blue-600 rounded text-xs font-medium tabular-nums">
              {taskCount}
            </span>
          )}
          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${style.bg} ${style.text}`}>
            {style.label}
          </span>
        </div>
      </div>
      {currentTask ? (
        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg px-3 py-2 group-hover:bg-gray-100 dark:group-hover:bg-gray-750 transition-colors duration-150">
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-0.5 font-medium">Current task</p>
          <p className="text-sm text-gray-700 dark:text-gray-300 truncate">{currentTask}</p>
          {projectId && (
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">in {projectId}</p>
          )}
        </div>
      ) : (
        <div className="bg-gray-50/50 dark:bg-gray-800/50 rounded-lg px-3 py-2 border border-dashed border-gray-200 dark:border-gray-700">
          <p className="text-xs text-gray-400 dark:text-gray-500 italic">No active task</p>
        </div>
      )}
    </div>
  );
}
