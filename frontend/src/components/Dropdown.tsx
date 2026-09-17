import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

export interface DropdownOption {
  id: string;
  label: string;
  /** Shown under the label in the menu; never in the closed trigger. */
  description?: string;
  /** Small trailing marker on the trigger and the row, e.g. a model version. */
  badge?: string;
}

interface DropdownProps {
  value: string;
  options: DropdownOption[];
  onChange: (id: string) => void;
  /** Short prefix on the trigger so three of these in a row stay distinguishable. */
  label: string;
  disabled?: boolean;
  /** Explains why the control is unavailable, when it is. */
  title?: string;
  /**
   * Which way the menu opens.
   *
   * `up` exists for the composer, which sits on the floor of its pane — a menu
   * dropping down from there opens off the bottom of the window. Everywhere
   * else is a toolbar or a page header, so down is the default and the one
   * place that needs the other says so.
   */
  placement?: 'up' | 'down';
}

/**
 * A single-select menu for the composer.
 *
 * Built rather than using <select> because each option carries a description —
 * "which preset is 'editorial'?" is the question the old chip row could not
 * answer, since a chip has room for a word and nothing else. A native select
 * can't show one either, and can't be styled to match the surrounding capsule.
 */
export function Dropdown({ value, options, onChange, label, disabled, title, placement = 'down' }: DropdownProps) {
  const [open, setOpen] = useState(false);
  /**
   * Where the menu goes, in viewport coordinates.
   *
   * It used to be `position: absolute`, which puts it in the trigger's
   * containing block — so every ancestor that clips got a vote. The composer
   * pane is `overflow: hidden` and took 39px off the デザイン menu; the extended
   * chat's settings sit in a `overflow-y: auto` column, which cut all four of
   * them off entirely. Anchoring to the viewport means no ancestor can clip it,
   * and the two flips — which way it opens, which edge it hangs from — are
   * decided against the window, which is the box that actually bounds it.
   *
   * Null until measured. Rendered invisible rather than at a guessed position,
   * so the first frame is never the wrong one.
   */
  const [box, setBox] = useState<React.CSSProperties | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const selected = options.find((o) => o.id === value) ?? options[0];

  const close = useCallback(() => setOpen(false), []);

  // Dismiss on outside click and on Escape, the two things every menu owes the user.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  /*
   * Measured on open, and again whenever the page moves under it.
   *
   * Layout effect so the placement happens before the frame is painted —
   * measuring in a plain effect draws the menu in the wrong place once.
   */
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const root = rootRef.current;
      const menu = listRef.current;
      if (!root || !menu) return;
      const r = root.getBoundingClientRect();
      const GAP = 6;
      // Not flush against the edge it was about to overflow.
      const EDGE = 8;
      const above = r.top - EDGE;
      const below = window.innerHeight - r.bottom - EDGE;
      const need = menu.scrollHeight + GAP;
      // The caller's preference, honoured while it fits; the other side when it
      // does not and the other side has more room. `up` exists for the composer,
      // which sits on the floor of its pane; the same control in a sidebar near
      // the top of the window has nothing above it to open into.
      const up = placement === 'up'
        ? (above >= need || above >= below)
        : !(below >= need || below >= above);
      const next: React.CSSProperties = {
        position: 'fixed',
        maxHeight: Math.max(140, Math.min(320, (up ? above : below) - GAP)),
      };
      if (up) next.bottom = window.innerHeight - r.top + GAP;
      else next.top = r.bottom + GAP;
      if (r.left + menu.offsetWidth > window.innerWidth - EDGE) {
        next.right = Math.max(EDGE, window.innerWidth - r.right);
      } else {
        next.left = Math.max(EDGE, r.left);
      }
      setBox(next);
    };
    place();
    /*
     * A viewport-anchored menu does not travel with its trigger, so it is
     * re-placed rather than left hanging over whatever scrolled under it.
     * Capture, because the scrolling happens on a pane and not on the window.
     */
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, placement]);

  // A stale position from the last time it was open must not be reused.
  useEffect(() => { if (!open) setBox(null); }, [open]);

  // Move focus into the menu so arrow keys and type-ahead work from the keyboard.
  useEffect(() => {
    if (open) listRef.current?.querySelector<HTMLElement>('[data-selected="true"], button')?.focus();
  }, [open]);

  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = Array.from(listRef.current?.querySelectorAll<HTMLElement>('button') ?? []);
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'ArrowDown' ? at + 1 : at - 1;
    items[(next + items.length) % items.length]?.focus();
  };

  return (
    <div className="dd" ref={rootRef}>
      <button
        type="button"
        className={`dd__trigger${open ? ' dd__trigger--open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title={title ?? `${label}: ${selected?.label ?? ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
      >
        <span className="dd__trigger-label">{label}</span>
        <span className="dd__trigger-value">{selected?.label}</span>
        {selected?.badge && <span className="dd__trigger-badge">{selected.badge}</span>}
        <svg className="dd__chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <ul
          className="dd__menu"
          style={box ?? { position: 'fixed', visibility: 'hidden' }}
          id={listId}
          role="listbox"
          ref={listRef}
          onKeyDown={onListKeyDown}
          aria-label={label}
        >
          {options.map((o) => (
            <li key={o.id} role="option" aria-selected={o.id === value}>
              <button
                type="button"
                className={`dd__opt${o.id === value ? ' dd__opt--selected' : ''}`}
                data-selected={o.id === value}
                onClick={() => {
                  onChange(o.id);
                  close();
                }}
              >
                <span className="dd__opt-check" aria-hidden="true">
                  {o.id === value && (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </span>
                <span className="dd__opt-text">
                  <span className="dd__opt-label">
                    {o.label}
                    {o.badge && <span className="dd__opt-badge">{o.badge}</span>}
                  </span>
                  {o.description && <span className="dd__opt-desc">{o.description}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
