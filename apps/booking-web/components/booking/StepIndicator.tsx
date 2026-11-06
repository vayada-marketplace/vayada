interface Step {
  number: number;
  label: string;
}

interface StepIndicatorProps {
  steps: Step[];
  currentStep: number;
  /** VAY-2448: a done step the guest can go back to (Rooms), shown as a button. */
  back?: { step: number; onClick: () => void; disabled?: boolean };
}

export default function StepIndicator({ steps, currentStep, back }: StepIndicatorProps) {
  return (
    <div className="flex items-center justify-center gap-0 md:gap-2 flex-shrink-0 w-full md:w-auto">
      {steps.map((step, index) => {
        const isCompleted = step.number < currentStep;
        const isCurrent = step.number === currentStep;
        const isActive = step.number <= currentStep;
        const content = (
          <>
            <div
              className={`w-5 h-5 md:w-6 md:h-6 rounded-full flex items-center justify-center text-[10px] md:text-xs font-bold shrink-0 ${
                isActive ? "bg-primary-600 text-white" : "bg-gray-200 text-gray-500"
              }`}
            >
              {isCompleted ? (
                <svg
                  className="w-3 h-3 md:w-3.5 md:h-3.5"
                  aria-hidden="true"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2.5}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
              ) : (
                step.number
              )}
            </div>
            {/* Mobile: only show label for current step. Desktop: show all */}
            <span
              className={`text-xs md:text-sm font-medium whitespace-nowrap ${
                isCurrent
                  ? "text-gray-900"
                  : isActive
                    ? "text-gray-900 hidden md:inline"
                    : "text-gray-400 hidden md:inline"
              }`}
            >
              {step.label}
            </span>
          </>
        );
        return (
          <div
            key={step.number}
            className="flex items-center"
            aria-current={isCurrent ? "step" : undefined}
          >
            {back && isCompleted && back.step === step.number ? (
              <button
                type="button"
                onClick={back.onClick}
                disabled={back.disabled}
                // The label is hidden on a phone; the button keeps its name.
                aria-label={step.label}
                className="-m-3 flex items-center gap-1 rounded-full p-3 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:opacity-40 md:gap-1.5"
              >
                {content}
              </button>
            ) : (
              <div className="flex items-center gap-1 md:gap-1.5">{content}</div>
            )}
            {index < steps.length - 1 && (
              <div
                className={`w-5 md:w-12 h-px mx-1 md:mx-2 ${
                  isCompleted ? "bg-primary-600" : "bg-gray-300"
                }`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
