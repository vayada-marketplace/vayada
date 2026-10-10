interface FeedbackAlertProps {
  type: "success" | "error";
  message: string;
  className?: string;
  action?: { label: string; onClick: () => void };
}

export function FeedbackAlert({ type, message, className = "", action }: FeedbackAlertProps) {
  return (
    <div
      className={`px-3 py-2.5 rounded-lg text-[13px] ${
        type === "success"
          ? "bg-green-50 text-green-800 border border-green-200"
          : "bg-red-50 text-red-800 border border-red-200"
      } ${className}`}
    >
      {action ? (
        <div className="flex items-center justify-between gap-3">
          <span>{message}</span>
          <button
            type="button"
            onClick={action.onClick}
            className="shrink-0 font-semibold underline underline-offset-2 hover:no-underline"
          >
            {action.label}
          </button>
        </div>
      ) : (
        message
      )}
    </div>
  );
}
