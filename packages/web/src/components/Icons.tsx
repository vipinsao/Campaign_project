import clsx from 'clsx';

/**
 * The few icons the UI needs, as inline SVG.
 *
 * These replace Unicode glyphs from the Misc Technical block (⌕ ⌖ ⌛ ⛨) that many
 * fonts — including a fresh Linux install's defaults — do not contain, so they
 * rendered as empty boxes. A path renders identically everywhere and inherits
 * `currentColor`.
 */
const PATHS = {
  search: 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14zM20 20l-4.2-4.2',
  shield: 'M12 3l7 3v5c0 4.5-3 8-7 10c-4-2-7-5.5-7-10V6l7-3zM9 12l2 2l4-4',
} as const;

export function Icon({ name, className }: { name: keyof typeof PATHS; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={clsx('inline-block shrink-0', className)}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
