/** Reusable skeleton loader components for loading states. */

export function SkeletonLine({ className = "" }: { className?: string }) {
  return (
    <div className={`animate-pulse bg-gray-200 rounded ${className}`} />
  );
}

export function SkeletonKPI() {
  return (
    <div className="bg-white rounded-xl shadow-sm border-l-4 border-gray-200 p-6 animate-pulse">
      <div className="bg-gray-200 rounded h-3 w-20 mb-3" />
      <div className="bg-gray-200 rounded h-8 w-12 mb-2" />
      <div className="bg-gray-200 rounded h-3 w-16" />
    </div>
  );
}

export function SkeletonAgentCard() {
  return (
    <div className="bg-white rounded-xl shadow-sm p-4 border border-gray-100 animate-pulse">
      <div className="flex items-center gap-3 mb-3">
        <div className="w-10 h-10 rounded-full bg-gray-200" />
        <div className="flex-1">
          <div className="bg-gray-200 rounded h-4 w-24 mb-1.5" />
          <div className="bg-gray-200 rounded h-3 w-16" />
        </div>
        <div className="bg-gray-200 rounded-full h-3 w-3" />
      </div>
      <div className="bg-gray-100 rounded-lg h-10" />
    </div>
  );
}

export function SkeletonTaskRow() {
  return (
    <div className="px-4 py-3 flex items-center justify-between animate-pulse">
      <div className="flex-1 min-w-0">
        <div className="bg-gray-200 rounded h-4 w-48 mb-1.5" />
        <div className="bg-gray-200 rounded h-3 w-20" />
      </div>
      <div className="bg-gray-200 rounded h-5 w-16 ml-3" />
    </div>
  );
}

export function SkeletonActivityItem() {
  return (
    <div className="px-6 py-3 flex items-start gap-3 animate-pulse">
      <div className="mt-0.5 w-2 h-2 rounded-full bg-gray-200 flex-shrink-0" />
      <div className="flex-1">
        <div className="bg-gray-200 rounded h-3.5 w-full mb-1.5" />
        <div className="bg-gray-200 rounded h-3 w-12" />
      </div>
    </div>
  );
}
