import type { ReactNode } from 'react';
import clsx from 'clsx';

/**
 * A hover/focus popover, CSS-only.
 *
 * Focusable, because every rate on the analytics screen carries its denominator in
 * one of these and a tooltip that only appears on hover is a tooltip a keyboard
 * user cannot read. `group-focus-within` does the same work as `group-hover`.
 */
export function Tooltip({
  children,
  content,
  align = 'center',
  width = 'w-72',
}: {
  children: ReactNode;
  content: ReactNode;
  align?: 'left' | 'center' | 'right';
  width?: string;
}) {
  return (
    <span className="group relative inline-flex">
      <span tabIndex={0} className="inline-flex cursor-help items-center rounded">
        {children}
      </span>
      <span
        role="tooltip"
        className={clsx(
          'pointer-events-none absolute bottom-full z-50 mb-1.5 hidden rounded-md border border-line-strong bg-raised px-3 py-2 text-left text-[12px] leading-relaxed font-normal text-ink shadow-xl shadow-black/60 group-hover:block group-focus-within:block',
          width,
          align === 'left' && 'left-0',
          align === 'center' && 'left-1/2 -translate-x-1/2',
          align === 'right' && 'right-0',
        )}
      >
        {content}
      </span>
    </span>
  );
}

/** The little superscript that says "there is something to hover here". */
export function InfoDot() {
  return (
    <span className="ml-1 inline-block size-1 translate-y-[-4px] rounded-full bg-ink-faint align-middle" />
  );
}
