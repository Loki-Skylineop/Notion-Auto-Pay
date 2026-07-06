"use client";

import { AlertCircle } from "lucide-react";
import { useId } from "react";
import { cn } from "@/lib/utils/cn";

interface BaseProps {
  label: string;
  error?: string;
  required?: boolean;
  className?: string;
}

type TextFieldProps = BaseProps &
  React.InputHTMLAttributes<HTMLInputElement>;

export function TextField({ label, error, required, className, id, ...rest }: TextFieldProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const errorId = `${fieldId}-error`;
  return (
    <div className={className}>
      <label htmlFor={fieldId} className="field-label">
        {label}
        {required && <span className="ml-0.5 text-ember-400">*</span>}
      </label>
      <input
        id={fieldId}
        aria-invalid={!!error}
        aria-describedby={error ? errorId : undefined}
        className={cn("field-input", error && "field-input-error")}
        {...rest}
      />
      {error && (
        <p id={errorId} className="mt-1.5 flex items-center gap-1 text-xs text-ember-300">
          <AlertCircle className="h-3.5 w-3.5" />
          {error}
        </p>
      )}
    </div>
  );
}

type TextAreaProps = BaseProps &
  React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export function TextArea({ label, error, required, className, id, ...rest }: TextAreaProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const errorId = `${fieldId}-error`;
  return (
    <div className={className}>
      <label htmlFor={fieldId} className="field-label">
        {label}
        {required && <span className="ml-0.5 text-ember-400">*</span>}
      </label>
      <textarea
        id={fieldId}
        aria-invalid={!!error}
        aria-describedby={error ? errorId : undefined}
        className={cn("field-input min-h-[84px] resize-y", error && "field-input-error")}
        {...rest}
      />
      {error && (
        <p id={errorId} className="mt-1.5 flex items-center gap-1 text-xs text-ember-300">
          <AlertCircle className="h-3.5 w-3.5" />
          {error}
        </p>
      )}
    </div>
  );
}
