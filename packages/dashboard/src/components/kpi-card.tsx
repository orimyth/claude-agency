interface KPICardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  trend?: "up" | "down" | "neutral";
  color?: string;
}

export function KPICard({
  title,
  value,
  subtitle,
  trend,
  color = "blue",
}: KPICardProps) {
  const colors: Record<string, string> = {
    blue: "border-blue-500",
    green: "border-green-500",
    yellow: "border-yellow-500",
    red: "border-red-500",
    purple: "border-purple-500",
  };

  return (
    <div
      className={`bg-white rounded-xl shadow-sm border-l-4 ${colors[color]} p-6`}
    >
      <p className="text-sm text-gray-500 font-medium">{title}</p>
      <p className="text-3xl font-bold mt-2">{value}</p>
      {subtitle && (
        <p className="text-sm text-gray-400 mt-1 flex items-center gap-1">
          {trend === "up" && <span className="text-green-500">+</span>}
          {trend === "down" && <span className="text-red-500">-</span>}
          {subtitle}
        </p>
      )}
    </div>
  );
}
