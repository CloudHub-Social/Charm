import type { FeedbackCategory } from "./instrument";

const OPTIONS: { value: FeedbackCategory; label: string }[] = [
  { value: "bug", label: "Bug" },
  { value: "feature_request", label: "Feature request" },
];

interface FeedbackCategoryFieldProps {
  /** Currently selected category, or `null` while nothing has been picked yet. */
  value: FeedbackCategory | null;
  onChange: (value: FeedbackCategory) => void;
  /** Groups the radio inputs — must be unique per rendered instance (e.g. two entry points on one page). */
  name: string;
  className?: string;
}

/**
 * Required Bug / Feature request selector shown before either feedback entry
 * point (`ObservabilityPanel`'s settings button, `ErrorFallback`'s crash
 * screen) opens Sentry's feedback dialog. Sentry's `feedbackIntegration` form
 * has no custom-field support (confirmed against the installed
 * `@sentry/react` build — only name/email/message/screenshot), so the
 * category is captured in Charm's own UI and threaded through
 * `openSentryFeedbackDialog`'s options into the `charm.feedback.category` tag
 * (see Spec 22).
 */
export function FeedbackCategoryField({
  value,
  onChange,
  name,
  className,
}: FeedbackCategoryFieldProps) {
  return (
    <fieldset className={className}>
      <legend className="text-sm font-medium text-foreground">
        What kind of feedback is this?
      </legend>
      <div className="mt-2 flex gap-4">
        {OPTIONS.map((option) => (
          <label key={option.value} className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              required
              className="h-4 w-4"
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
