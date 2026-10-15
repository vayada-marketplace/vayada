import { cn } from "@/lib/utils";

/**
 * The frame every admin page renders in, so titles and content start at the same place on every
 * page (VAY-2199). `full` drops the max width but keeps the left edge (Design Studio).
 */
export function PageLayout({
  variant = "contained",
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { variant?: "contained" | "full" }) {
  return (
    <div
      className={cn(variant === "full" ? "page-frame-full" : "page-frame", className)}
      {...props}
    />
  );
}

/**
 * A page's title block: optional breadcrumb, the title, an optional subtitle and actions on the
 * right. The first section after it starts --page-header-gap below, on every page.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  breadcrumb,
  className,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  breadcrumb?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("page-header", className)}>
      {breadcrumb && <div className="mb-2">{breadcrumb}</div>}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-gray-900 md:text-2xl">{title}</h1>
          {subtitle && (
            <p className="mt-[var(--page-subtitle-gap)] text-[13px] text-gray-500">{subtitle}</p>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}
