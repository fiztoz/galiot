import type { ReactNode } from 'react';
import { Check } from 'lucide-react';

interface CheckboxProps {
  id?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
}

/**
 * Themed checkbox. The native input stays in the tree (screen readers, form
 * semantics, keyboard) but is visually replaced by a teal box with a check,
 * so dark mode no longer shows a raw browser control.
 */
export function Checkbox({ id, checked, onChange, children, disabled = false, className = '' }: CheckboxProps) {
  return (
    <label
      className={`flex items-start gap-2.5 text-sm text-zinc-600 dark:text-zinc-300 cursor-pointer select-none ${
        disabled ? 'opacity-50 cursor-not-allowed' : ''
      } ${className}`}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className={`mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded border transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-teal-500 ${
          checked
            ? 'border-teal-600 bg-teal-600 text-white'
            : 'border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-950 text-transparent'
        }`}
      >
        <Check size={11} strokeWidth={3} />
      </span>
      <span className="min-w-0">{children}</span>
    </label>
  );
}
