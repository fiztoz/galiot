import { useEffect, useRef, type ReactNode } from 'react';
import { Check, Minus } from 'lucide-react';

interface CheckboxProps {
  id?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  children?: ReactNode;
  disabled?: boolean;
  className?: string;
  /** Mixed state for select-all headers; renders a dash instead of a check. */
  indeterminate?: boolean;
  ariaLabel?: string;
}

/**
 * Themed checkbox. The native input stays in the tree (screen readers, form
 * semantics, keyboard) but is visually replaced by a teal box with a check,
 * so dark mode no longer shows a raw browser control.
 */
export function Checkbox({
  id,
  checked,
  onChange,
  children,
  disabled = false,
  className = '',
  indeterminate = false,
  ariaLabel,
}: CheckboxProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate && !checked;
  }, [indeterminate, checked]);
  return (
    <label
      className={`flex items-start gap-2.5 text-sm text-zinc-600 dark:text-zinc-300 cursor-pointer select-none ${
        disabled ? 'opacity-50 cursor-not-allowed' : ''
      } ${className}`}
    >
      <span className="relative mt-0.5 inline-flex h-4 w-4 flex-none">
        <input
          ref={inputRef}
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-label={ariaLabel}
          onChange={(event) => onChange(event.target.checked)}
          className="peer absolute inset-0 z-10 m-0 h-full w-full cursor-[inherit] opacity-0"
        />
        <span
          aria-hidden="true"
          className={`pointer-events-none flex h-full w-full items-center justify-center rounded border transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-teal-500 ${
            checked || indeterminate
              ? 'border-teal-600 bg-teal-600 text-white'
              : 'border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-950 text-transparent'
          }`}
        >
          {checked ? <Check size={11} strokeWidth={3} /> : indeterminate ? <Minus size={11} strokeWidth={3} /> : null}
        </span>
      </span>
      {children !== undefined && <span className="min-w-0">{children}</span>}
    </label>
  );
}
