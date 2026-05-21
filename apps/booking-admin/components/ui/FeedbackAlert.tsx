interface FeedbackAlertProps {
  type: "success" | "error";
  message: string;
  className?: string;
}

export function FeedbackAlert({ type, message, className = "" }: FeedbackAlertProps) {
  return (
    <div
      className={`px-3 py-2.5 rounded-lg text-[13px] ${
        type === "success"
          ? "bg-green-50 text-green-800 border border-green-200"
          : "bg-red-50 text-red-800 border border-red-200"
      } ${className}`}
    >
      {message}
    </div>
  );
}
