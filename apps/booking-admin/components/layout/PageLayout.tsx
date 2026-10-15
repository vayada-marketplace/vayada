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
