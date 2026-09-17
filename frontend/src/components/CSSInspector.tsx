import { useState } from 'react';
import { readOverrides, readText } from '../utils/directEdit';

interface CSSInspectorProps {
  selector: string | null;
  html: string | null;
  /**
   * Applies a style change immediately. Absent makes the panel read-only, which
   * is what a version being viewed from history should be.
   */
  onEdit?: (selector: string, property: string, value: string) => void;
  /** Absent for React output, where the rendered DOM has no path back to a .tsx file. */
  onEditText?: (selector: string, text: string) => void;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractStylesFromBlocks(html: string, selector: string): Record<string, string> {
  const styles: Record<string, string> = {};
  const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)];
  for (const block of styleBlocks) {
    const css = block[1];
    const escapedSel = escapeRegExp(selector);
    const ruleRegex = new RegExp(`(?:^|[,{};\\s])${escapedSel}\\s*\\{([^}]+)\\}`, 'gi');
    let match;
    while ((match = ruleRegex.exec(css)) !== null) {
      const declarations = match[1].split(';').filter(Boolean);
      for (const decl of declarations) {
        const colonIdx = decl.indexOf(':');
        if (colonIdx > 0) {
          const prop = decl.slice(0, colonIdx).trim();
          const val = decl.slice(colonIdx + 1).trim();
          if (prop && val) styles[prop] = val;
        }
      }
    }
  }
  return styles;
}

function extractInlineStyles(html: string, selector: string): Record<string, string> {
  const styles: Record<string, string> = {};

  // Simple approach: look for the selector in the HTML and extract inline style
  // This is a best-effort extraction from the HTML source
  const tagMatch = selector.match(/^(\w+)/);
  if (!tagMatch) return styles;

  const tag = escapeRegExp(tagMatch[1]);
  const classMatch = selector.match(/\.([^\s.#]+)/g);

  // Build a regex to find elements with these attributes
  let pattern: string;
  if (classMatch && classMatch.length > 0) {
    const classes = classMatch.map((c) => escapeRegExp(c.slice(1))).join('[^"]*');
    pattern = `<${tag}[^>]*class="[^"]*${classes}[^"]*"[^>]*style="([^"]*)"`;
  } else {
    pattern = `<${tag}[^>]*style="([^"]*)"`;
  }

  try {
    const regex = new RegExp(pattern, 'i');
    const match = regex.exec(html);
    if (match && match[1]) {
      const declarations = match[1].split(';').filter(Boolean);
      for (const decl of declarations) {
        const [prop, val] = decl.split(':').map((s) => s.trim());
        if (prop && val) {
          styles[prop] = val;
        }
      }
    }
  } catch {
    // regex construction failed, return empty
  }

  return styles;
}

/**
 * Properties offered for direct editing.
 *
 * A short list on purpose. These are the changes people actually make by hand
 * after looking at a generated screen — it is too pale, too tight, the wrong
 * size — and each is a single value with an obvious control. Anything
 * structural stays with the chat, where a model can reason about the layout
 * rather than being handed one number.
 */
const EDITABLE: { prop: string; label: string; kind: 'color' | 'text' }[] = [
  { prop: 'color', label: '文字色', kind: 'color' },
  { prop: 'background-color', label: '背景色', kind: 'color' },
  { prop: 'font-size', label: '文字サイズ', kind: 'text' },
  { prop: 'font-weight', label: '太さ', kind: 'text' },
  { prop: 'padding', label: '内側の余白', kind: 'text' },
  { prop: 'margin', label: '外側の余白', kind: 'text' },
  { prop: 'border-radius', label: '角丸', kind: 'text' },
  { prop: 'gap', label: '要素間', kind: 'text' },
];

/** A CSS colour this input can show. Anything else falls back to a text field. */
function asHex(value: string | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  if (/^#[0-9a-f]{3}$/i.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(v);
  if (rgb) {
    return `#${[1, 2, 3].map((i) => Number(rgb[i]).toString(16).padStart(2, '0')).join('')}`;
  }
  return null;
}

export function CSSInspector({ selector, html, onEdit, onEditText }: CSSInspectorProps) {
  const [textDraft, setTextDraft] = useState<string | null>(null);
  if (!selector || !html) return null;

  const generated = { ...extractStylesFromBlocks(html, selector), ...extractInlineStyles(html, selector) };
  const overrides = readOverrides(html, selector);
  // What the element actually shows: the override wins, because that is the rule
  // that comes last. Showing the generated value next to an edit that overrode it
  // would be reporting a value the user cannot see anywhere on the page.
  const effective = { ...generated, ...overrides };
  const editable = Boolean(onEdit);
  const currentText = onEditText ? readText(html, selector) : null;

  return (
    <section className="css-inspector" aria-label="CSS インスペクター">
      <div className="css-inspector__header">
        <span className="css-inspector__title">要素情報</span>
      </div>
      <div className="css-inspector__selector">
        <span className="css-inspector__selector-label">選択中:</span>
        <code className="css-inspector__selector-value">{selector}</code>
      </div>

      {currentText !== null && onEditText && (
        <div className="css-inspector__text">
          <label className="css-inspector__field-label" htmlFor="ci-text">テキスト</label>
          <textarea
            id="ci-text"
            className="css-inspector__textarea"
            rows={2}
            value={textDraft ?? currentText}
            onChange={(e) => setTextDraft(e.target.value)}
            onBlur={() => {
              if (textDraft !== null && textDraft !== currentText) onEditText(selector, textDraft);
              setTextDraft(null);
            }}
          />
        </div>
      )}

      {editable && (
        <div className="css-inspector__fields">
          {EDITABLE.map(({ prop, label, kind }) => {
            const value = effective[prop] ?? '';
            const hex = kind === 'color' ? asHex(value) : null;
            const changed = prop in overrides;
            return (
              <div key={prop} className="css-inspector__field">
                <label className="css-inspector__field-label" htmlFor={`ci-${prop}`}>
                  {label}
                  {/* Marks a value the user set, so a hand edit is distinguishable
                      from what was generated — and so it is clear what "戻す" undoes. */}
                  {changed && <button
                    type="button"
                    className="css-inspector__revert"
                    onClick={() => onEdit!(selector, prop, '')}
                    title="この変更を取り消す"
                  >戻す</button>}
                </label>
                <div className="css-inspector__control">
                  {kind === 'color' && (
                    <input
                      type="color"
                      className="css-inspector__swatch"
                      value={hex ?? '#000000'}
                      onChange={(e) => onEdit!(selector, prop, e.target.value)}
                      aria-label={`${label}を選ぶ`}
                    />
                  )}
                  <input
                    id={`ci-${prop}`}
                    type="text"
                    className={`css-inspector__input${changed ? ' css-inspector__input--changed' : ''}`}
                    defaultValue={value}
                    placeholder="—"
                    onBlur={(e) => {
                      if (e.target.value.trim() !== value.trim()) onEdit!(selector, prop, e.target.value);
                    }}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="css-inspector__hint">
        {editable
          ? '値を変えるとすぐ反映されます（生成は走りません）。レイアウトや構成の変更は修正指示欄からどうぞ。'
          : '修正指示欄で要素を指定して修正できます'}
      </p>
    </section>
  );
}
