import type { ReactNode } from "react";

/** The PMS page title: one size, weight and line height on every page (VAY-2413). */
export const pageTitleClassName = "text-2xl font-bold text-gray-900 md:text-xl";

export function PageTitle({ children }: { children: ReactNode }) {
  return <h1 className={pageTitleClassName}>{children}</h1>;
}

/**
 * A PMS page's title with an optional subtitle and actions (VAY-2413). The actions sit right of
 * the title. From md up the subtitle sits right under the title; on phones it takes the full
 * width under the actions, so it doesn't share the line with the buttons (VAY-2338).
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  className = "",
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`grid items-start gap-x-4 ${actions ? "grid-cols-[minmax(0,1fr)_auto]" : ""} ${className}`}
    >
      <PageTitle>{title}</PageTitle>
      {actions && <div className="flex items-center gap-2 md:row-span-2">{actions}</div>}
      {subtitle && (
        <div className="col-span-full mt-1 text-sm text-gray-500 md:col-span-1">{subtitle}</div>
      )}
    </div>
  );
}
