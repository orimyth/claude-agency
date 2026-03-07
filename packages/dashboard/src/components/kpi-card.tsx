interface KPICardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  trend?: "up" | "down" | "neutral";
  color?: string;
  icon?: "agents" | "tasks" | "check" | "clock" | "alert" | "pause";
}

const BORDER_COLORS: Record<string, string> = {
  blue: "border-blue-500",
  green: "border-emerald-500",
  yellow: "border-amber-500",
  red: "border-red-500",
  purple: "border-purple-500",
};

const ICON_COLORS: Record<string, string> = {
  blue: "text-blue-500 bg-blue-50",
  green: "text-emerald-500 bg-emerald-50",
  yellow: "text-amber-500 bg-amber-50",
  red: "text-red-500 bg-red-50",
  purple: "text-purple-500 bg-purple-50",
};

const ICON_PATHS: Record<string, string> = {
  agents: "M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z",
  tasks: "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2",
  check: "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z",
  clock: "M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z",
  alert: "M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z",
  pause: "M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z",
};

export function KPICard({
  title,
  value,
  subtitle,
  trend,
  color = "blue",
  icon,
}: KPICardProps) {
  return (
    <div
      className={`bg-white dark:bg-gray-900 rounded-xl shadow-sm border-l-4 ${BORDER_COLORS[color] ?? BORDER_COLORS.blue} p-5 transition-all duration-300 hover:shadow-md`}
    >
      <div className="flex items-start justify-between">
        <p className="text-xs text-gray-500 dark:text-gray-400 font-medium uppercase tracking-wide">{title}</p>
        {icon && (
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${ICON_COLORS[color] ?? ICON_COLORS.blue}`}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={ICON_PATHS[icon]} />
            </svg>
          </div>
        )}
      </div>
      <p className="text-3xl font-bold mt-2 tabular-nums transition-all duration-300 dark:text-white">{value}</p>
      {subtitle && (
        <p className="text-sm text-gray-400 dark:text-gray-500 mt-1 flex items-center gap-1">
          {trend === "up" && (
            <svg className="w-3.5 h-3.5 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 15l7-7 7 7" />
            </svg>
          )}
          {trend === "down" && (
            <svg className="w-3.5 h-3.5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
            </svg>
          )}
          {subtitle}
        </p>
      )}
    </div>
  );
}
