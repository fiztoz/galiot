import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  id?: string;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  disabled?: boolean;
  /** Extra classes for the trigger button (sizing, width). */
  className?: string;
  placeholder?: string;
}

const TRIGGER_CLASS =
  'w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-xs bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-700 rounded-lg text-zinc-700 dark:text-zinc-200 focus:outline-none focus:ring-1 focus:ring-teal-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors';

/**
 * Themed listbox dropdown replacing the native `<select>`, whose popup ignores
 * the app palette. Keyboard: arrows/Home/End move, Enter/Space pick, Escape
 * closes, a printable character jumps to the next matching option. Focus stays
 * on the trigger and the active option is exposed via aria-activedescendant.
 */
export function Select({
  value,
  onChange,
  options,
  id,
  ariaLabel,
  ariaLabelledBy,
  disabled = false,
  className = '',
  placeholder = 'Select…',
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [placeAbove, setPlaceAbove] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  // Scroll only the listbox, never the dialog underneath it.
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    const node = list?.children[active] as HTMLElement | undefined;
    if (!list || !node) return;
    const top = node.offsetTop;
    const bottom = top + node.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }, [open, active]);

  const openList = () => {
    if (disabled || options.length === 0) return;
    setActive(Math.max(0, selectedIndex));
    // Flip up when the viewport edge would clip the list (short dialogs).
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      const needed = Math.min(options.length * 28 + 8, 224);
      const below = window.innerHeight - rect.bottom;
      setPlaceAbove(below < needed && rect.top > below);
    }
    setOpen(true);
  };

  const commit = (index: number) => {
    const option = options[index];
    if (option) onChange(option.value);
    setOpen(false);
    buttonRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault();
        openList();
      }
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActive((index) => Math.min(options.length - 1, index + 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActive((index) => Math.max(0, index - 1));
        break;
      case 'Home':
        event.preventDefault();
        setActive(0);
        break;
      case 'End':
        event.preventDefault();
        setActive(options.length - 1);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        commit(active);
        break;
      case 'Escape':
        // Stop here: host dialogs/panels listen for Escape on window/document
        // and must not close while the listbox is the thing being dismissed.
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        break;
      case 'Tab':
        setOpen(false);
        break;
      default: {
        if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          const char = event.key.toLowerCase();
          const start = active + 1;
          for (let step = 0; step < options.length; step++) {
            const index = (start + step) % options.length;
            if ((options[index]?.label ?? '').toLowerCase().startsWith(char)) {
              setActive(index);
              break;
            }
          }
        }
      }
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        id={id}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? optionId(active) : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
        className={`${TRIGGER_CLASS} ${className}`}
      >
        <span className={`truncate ${selected ? '' : 'text-zinc-400 dark:text-zinc-500'}`}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown
          size={13}
          className={`flex-none text-zinc-400 transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>

      {open && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          className={`absolute left-0 z-50 w-full max-h-56 overflow-auto py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-xl ${
            placeAbove ? 'bottom-full mb-1' : 'top-full mt-1'
          }`}
        >
          {options.map((option, index) => (
            <li
              key={option.value}
              id={optionId(index)}
              role="option"
              aria-selected={option.value === value}
              onMouseEnter={() => setActive(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => commit(index)}
              className={`flex items-center justify-between gap-2 px-2.5 py-1.5 text-xs cursor-pointer ${
                index === active ? 'bg-zinc-100 dark:bg-zinc-800' : ''
              } ${
                option.value === value
                  ? 'text-teal-700 dark:text-teal-300 font-medium'
                  : 'text-zinc-700 dark:text-zinc-200'
              }`}
            >
              <span className="truncate">{option.label}</span>
              {option.value === value && <Check size={13} className="flex-none" aria-hidden="true" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
