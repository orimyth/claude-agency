import Image from "next/image";

interface AgentCardProps {
  name: string;
  role: string;
  status: string;
  avatar?: string | null;
  currentTask?: string;
  onClick?: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-500",
  idle: "bg-gray-400",
  paused: "bg-yellow-500",
  on_break: "bg-orange-400",
  error: "bg-red-500",
};

const STATUS_LABELS: Record<string, string> = {
  active: "Working",
  idle: "Idle",
  paused: "Paused",
  on_break: "On Break",
  error: "Error",
};

export function AgentCard({
  name,
  role,
  status,
  avatar,
  currentTask,
  onClick,
}: AgentCardProps) {
  return (
    <div
      onClick={onClick}
      className="bg-white rounded-xl shadow-sm p-4 hover:shadow-md transition-shadow cursor-pointer border border-gray-100"
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          {avatar ? (
            <Image
              src={avatar}
              alt={name}
              width={40}
              height={40}
              className="w-10 h-10 rounded-full object-cover"
            />
          ) : (
            <div className="w-10 h-10 bg-gray-100 rounded-full flex items-center justify-center text-lg font-bold text-gray-600">
              {name[0]}
            </div>
          )}
          <div>
            <p className="font-semibold text-gray-900">{name}</p>
            <p className="text-sm text-gray-500">{role}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className={`w-2.5 h-2.5 rounded-full ${STATUS_COLORS[status]}`} />
          <span className="text-sm text-gray-500">
            {STATUS_LABELS[status] ?? status}
          </span>
        </div>
      </div>
      {currentTask && (
        <div className="bg-gray-50 rounded-lg px-3 py-2 text-sm text-gray-600 truncate">
          {currentTask}
        </div>
      )}
    </div>
  );
}
