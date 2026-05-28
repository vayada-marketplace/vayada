"use client";

import { ChartBarIcon } from "@heroicons/react/24/outline";
import { ChartPoint } from "@/services/platformAdmin";

function pointsPath(points: ChartPoint[], width: number, height: number, pad: number) {
  const max = Math.max(...points.map((p) => p.value), 1);
  const step = points.length > 1 ? (width - pad * 2) / (points.length - 1) : width - pad * 2;
  return points
    .map((point, index) => {
      const x = pad + index * step;
      const y = height - pad - (point.value / max) * (height - pad * 2);
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

export function LineChart({
  points,
  tone = "lagoon",
}: {
  points: ChartPoint[];
  tone?: "lagoon" | "brass";
}) {
  const width = 720;
  const height = 240;
  const pad = 24;
  const max = Math.max(...points.map((p) => p.value), 1);
  const line = pointsPath(points, width, height, pad);
  const area = `${line} L ${width - pad} ${height - pad} L ${pad} ${height - pad} Z`;
  const stroke = tone === "brass" ? "#b08d4a" : "#246f78";

  return (
    <div className="relative min-h-[260px] overflow-hidden rounded-md border border-ink/10 bg-white">
      {points.length === 0 ? <EmptyChart /> : null}
      <svg viewBox={`0 0 ${width} ${height}`} className="h-[260px] w-full" role="img">
        <path d={area} fill={stroke} opacity="0.12" />
        <path d={line} fill="none" stroke={stroke} strokeLinecap="round" strokeWidth="3" />
        {points.map((point, index) => {
          const step = points.length > 1 ? (width - pad * 2) / (points.length - 1) : 0;
          const x = pad + index * step;
          const y = height - pad - (point.value / max) * (height - pad * 2);
          return (
            <g key={`${point.key}-${index}`}>
              <circle cx={x} cy={y} r="4" fill={stroke}>
                <title>{`${point.label}: ${point.value}`}</title>
              </circle>
            </g>
          );
        })}
      </svg>
      <AxisLabels points={points} />
    </div>
  );
}

export function BarChart({ points }: { points: ChartPoint[] }) {
  const max = Math.max(...points.map((p) => p.value), 1);
  return (
    <div className="relative min-h-[260px] rounded-md border border-ink/10 bg-white px-4 pb-8 pt-5">
      {points.length === 0 ? <EmptyChart /> : null}
      <div className="flex h-[210px] items-end gap-2">
        {points.map((point) => (
          <div key={point.key} className="group flex h-full min-w-7 flex-1 items-end">
            <div
              className="w-full rounded-t bg-reed transition group-hover:bg-lagoon"
              style={{ height: `${Math.max((point.value / max) * 100, point.value ? 6 : 1)}%` }}
              title={`${point.label}: ${point.value}`}
            />
          </div>
        ))}
      </div>
      <AxisLabels points={points} />
    </div>
  );
}

function AxisLabels({ points }: { points: ChartPoint[] }) {
  const visible = points.filter((_, index) => {
    if (points.length <= 12) return true;
    return index === 0 || index === points.length - 1 || index % 5 === 0;
  });
  return (
    <div className="absolute inset-x-4 bottom-2 flex justify-between text-[11px] text-ink/45">
      {visible.map((point) => (
        <span key={point.key}>{point.label}</span>
      ))}
    </div>
  );
}

function EmptyChart() {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-white/80 text-sm text-ink/55">
      <ChartBarIcon className="h-5 w-5" aria-hidden="true" />
      No chart data
    </div>
  );
}
