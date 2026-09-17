import { useRef, useState } from 'react';
import { Dropdown } from './Dropdown';
import { LiveFrame } from './LiveFrame';
import { versionOptions } from '../utils/versionOptions';
import type { VersionEntry } from '../hooks/useHistory';
import type { VersionSide } from './versionSide';
import type { DiffLine, DiffRow } from '../utils/sideBySideDiff';
import type { FileDiff } from '../utils/fileDiff';
import { summarise } from '../utils/fileDiff';

/**
 * Which version a panel is showing.
 *
 * Its own heading rather than a control in the top bar. Two selects up there
 * read as settings for the view; one at the top of each column reads as what
 * that column is, which is the question being asked of it. Shown for both tabs,
 * because choosing what to compare is not a property of how you look at it.
 */
export function SidePicker({
  side, versions, onSelect, otherVersionId, label,
}: {
  side: VersionSide;
  versions: VersionEntry[];
  onSelect: (versionId: string) => void;
  otherVersionId: string;
  /** Which panel this heads. The only thing distinguishing two identical menus. */
  label: string;
}) {
  /*
   * The other side's choice is marked rather than removed.
   *
   * Comparing a version with itself is a legitimate thing to ask for by
   * accident and a confusing thing to discover — two identical panels and no
   * indication why — so the row says so instead of vanishing from the list.
   */
  const options = versionOptions(versions).map((o) =>
    o.id && o.id === otherVersionId
      ? { ...o, description: `${o.description ?? ''}（もう一方と同じ）` }
      : o
  );

  return (
    <div className="vc__side-head">
      <Dropdown
        label={label}
        value={side.versionId}
        onChange={onSelect}
        disabled={side.loading}
        options={options}
      />
      {side.loading && <span className="vc__side-status">読み込み中…</span>}
    </div>
  );
}

/** The running document for one side. */
export function SideFrame({
  side, hash, onNavigate,
}: {
  side: VersionSide;
  hash: string | null;
  onNavigate: (hash: string) => void;
}) {
  return (
    <div className="vc__frame">
      {side.error
        ? <p className="live-frame__error" role="alert">{side.error}</p>
        : <LiveFrame html={side.html} title="比較対象" hash={hash} onNavigate={onNavigate} />}
    </div>
  );
}

function Cell({ line, side }: { line: DiffLine | null; side: 'left' | 'right' }) {
  if (!line) return <div className="vc__cell vc__cell--blank" aria-hidden="true" />;
  const changed = line.type !== 'context';
  const num = side === 'left' ? line.oldLine : line.newLine;
  return (
    <div className={`vc__cell${changed ? ` vc__cell--${line.type}` : ''}`}>
      <span className="vc__linenum">{num ?? ''}</span>
      <span className="vc__gutter">{changed ? (side === 'left' ? '−' : '+') : ' '}</span>
      <span className="vc__content">{line.content || ' '}</span>
    </div>
  );
}

/** How many lines moved, in the shape every review tool writes it. */
function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="vc__counts">
      {added > 0 && <span className="vc__count vc__count--add">+{added}</span>}
      {removed > 0 && <span className="vc__count vc__count--del">−{removed}</span>}
    </span>
  );
}

const STATUS_LABEL: Record<FileDiff['status'], string> = {
  added: '追加',
  removed: '削除',
  modified: '変更',
};

function Rows({ rows }: { rows: DiffRow[] }) {
  return (
    <>
      {rows.map((row, i) =>
        row.skip ? (
          <div className="vc__skip" key={i}>{row.skip}</div>
        ) : (
          <div className="vc__diffrow" key={i}>
            <Cell line={row.left} side="left" />
            <Cell line={row.right} side="right" />
          </div>
        )
      )}
    </>
  );
}

/**
 * The code difference, by file.
 *
 * Two things the previous single stream could not do. It could not say which
 * file a change was in — a generated project is many files inside one
 * transported document, and a run that touches one screen looked like a change
 * somewhere in the middle of a very long text. And it did not fit: the rows
 * were laid out at `max-content`, so one long line made the table wider than
 * the window and pushed the right-hand version off the edge of it, which is the
 * one thing a comparison must never do.
 *
 * So: a list of what changed at the top, each file its own section under a
 * heading that sticks while you read it, and two columns that are half the
 * pane each. Long lines wrap rather than scroll — within a row the two cells
 * are cells of the same grid row, so the taller one sets the height and the two
 * sides stay level however far either wraps.
 */
export function CodeDiff({ files }: { files: FileDiff[] }) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const sections = useRef(new Map<string, HTMLElement>());
  const total = summarise(files);

  const toggle = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  /* Jumping to a file that is folded shut would land on its heading and show
     nothing, so the jump opens it. */
  const jumpTo = (path: string) => {
    setCollapsed((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
    sections.current.get(path)?.scrollIntoView({ block: 'start' });
  };

  return (
    <div className="vc__code" role="region" aria-label="コード差分">
      <nav className="vc__files" aria-label="変更されたファイル">
        <span className="vc__files-total">
          {total.files} ファイルが変更 <Counts added={total.added} removed={total.removed} />
        </span>
        {files.map((f) => (
          <button
            key={f.path}
            className={`vc__filechip vc__filechip--${f.status}`}
            onClick={() => jumpTo(f.path)}
            type="button"
            title={f.path}
          >
            <span className="vc__filechip-path">{f.path}</span>
            <Counts added={f.added} removed={f.removed} />
          </button>
        ))}
      </nav>

      {files.map((f) => (
        <section
          className="vc__file"
          key={f.path}
          ref={(el) => {
            if (el) sections.current.set(f.path, el);
            else sections.current.delete(f.path);
          }}
        >
          <header className="vc__file-head">
            <button
              className="vc__file-toggle"
              onClick={() => toggle(f.path)}
              type="button"
              aria-expanded={!collapsed.has(f.path)}
            >
              <span className="vc__file-caret" aria-hidden="true">{collapsed.has(f.path) ? '▸' : '▾'}</span>
              <span className="vc__file-path">{f.path}</span>
            </button>
            <span className={`vc__file-status vc__file-status--${f.status}`}>{STATUS_LABEL[f.status]}</span>
            <Counts added={f.added} removed={f.removed} />
          </header>

          {!collapsed.has(f.path) && (
            <div className="vc__file-body">
              {f.note && <p className="vc__file-note">{f.note}</p>}
              <Rows rows={f.rows} />
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
