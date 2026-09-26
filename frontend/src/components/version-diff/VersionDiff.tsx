import { useState, useEffect, useMemo, useRef } from 'react';
import { useVersionSide } from './versionSide';
import { SidePicker, SideFrame, CodeDiff } from './versionDiffBody';
import { diffFileSets } from '../../utils/editing/fileDiff';
import { splitHtmlToFiles } from '../../utils/preview/virtualFs';
import type { VersionEntry } from '../../hooks/useHistory';
import { usePresence } from '../../hooks/usePresence';
import { SlidingIndicator } from '../common/SlidingIndicator';

interface VersionDiffProps {
  currentHtml: string | null;
  versions: VersionEntry[];
  apiUrl: string;
  token: string;
  /** The project, so a shared project's versions are read from its owner's history. */
  projectId?: string;
}

function computeLineDiff(oldText: string, newText: string): { added: number; removed: number } {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  const oldCounts = new Map<string, number>();
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);

  const newCounts = new Map<string, number>();
  for (const line of newLines) newCounts.set(line, (newCounts.get(line) ?? 0) + 1);

  let added = 0;
  let removed = 0;

  for (const [line, count] of newCounts) {
    const oldCount = oldCounts.get(line) ?? 0;
    if (count > oldCount) added += count - oldCount;
  }
  for (const [line, count] of oldCounts) {
    const newCount = newCounts.get(line) ?? 0;
    if (count > newCount) removed += count - newCount;
  }

  return { added, removed };
}

export function VersionDiff({ currentHtml, versions, apiUrl, token, projectId }: VersionDiffProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [diffTab, setDiffTab] = useState<'visual' | 'code'>('visual');
  /**
   * The screen both sides are showing, and whether they follow each other.
   *
   * Following is on by default because it is the question being asked: a list
   * screen looks the same in both versions until you open the detail view that
   * changed, and lining the two up by hand on every click is the work this is
   * meant to remove. It can be turned off, since sometimes the point is exactly
   * to look at two different screens.
   */
  const [linked, setLinked] = useState(true);
  const [hash, setHash] = useState<string | null>(null);

  /*
   * Two sides of the same kind, rather than a stored version on the left and
   * the live document on the right.
   *
   * The asymmetry was in the code before it was in the UI: only one side had a
   * `versionId` at all, so comparing two stored versions — what you want the
   * moment a regression is a few runs old — could not be expressed. Both are a
   * `VersionSide` now, and the live document is simply the choice with no id.
   */
  const left = useVersionSide(apiUrl, token, currentHtml, projectId);
  const right = useVersionSide(apiUrl, token, currentHtml, projectId);

  /**
   * How far down the app's own header reaches.
   *
   * Measured rather than written down. The header has no fixed height in the
   * stylesheet — it is padding around its content — so a number here would be a
   * copy that goes stale the first time anything in it changes size.
   */
  const [headerBottom, setHeaderBottom] = useState(0);
  const sheet = usePresence(isOpen);
  useEffect(() => {
    if (!isOpen) return;
    const header = document.querySelector('.app__header');
    setHeaderBottom(header ? Math.round(header.getBoundingClientRect().bottom) : 0);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setIsOpen(false); };
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener('keydown', onKey);
    };
  }, [isOpen]);

  /*
   * Both sides choose when the view opens, not at mount.
   *
   * `versions` is empty until the history loads, so a choice made at mount would
   * have nothing to choose. Opening is also the first moment the choice matters.
   *
   * The newest against the one before it. The right side used to open on the
   * live document while the left took the newest version — which are the same
   * document, every path that changes it writing a version — so the comparison
   * opened comparing something with itself and said 「変更なし」. The last run
   * against the run before it is the question this view is opened to ask.
   */
  const openedRef = useRef(false);
  useEffect(() => {
    if (!isOpen) { openedRef.current = false; return; }
    if (openedRef.current || versions.length === 0) return;
    openedRef.current = true;
    left.select((versions[1] ?? versions[0]).versionId);
    right.select(versions[0].versionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, versions.length]);

  const a = left.side.html;
  const b = right.side.html;
  const hasChanges = a !== null && b !== null && a !== b;
  const diffStats = a && b ? computeLineDiff(a, b) : null;

  /*
   * Split into files before diffing, and only for the tab that shows it.
   *
   * The alignment is quadratic in the length of what it is given, so it is not
   * work to do behind the visual tab where nothing would read the result. The
   * badge above uses the cheap multiset count instead, which is all a 「+42 −18」
   * needs.
   */
  const fileDiffs = useMemo(
    () => (diffTab === 'code' && a && b && a !== b
      ? diffFileSets(splitHtmlToFiles(a), splitHtmlToFiles(b))
      : []),
    [diffTab, a, b]
  );

  return (
    <>
      <button
        className="version-diff__open"
        onClick={() => setIsOpen(true)}
        type="button"
        disabled={!currentHtml}
        title={currentHtml ? '別のバージョンと並べて比較します' : '比較できるドキュメントがまだありません'}
      >
        比較
      </button>

      {sheet.mounted && (
        <div
          className="vc"
          role="dialog"
          aria-modal="true"
          aria-label="バージョン比較"
          style={{ top: headerBottom }}
          data-state={sheet.state}
        >
          <header className="vc__bar">
            <span className="vc__title">バージョン比較</span>

            {a && b && (
              <>
                <span className={`vc__badge vc__badge--${hasChanges ? 'changed' : 'same'}`}>
                  {hasChanges ? '変更あり' : '変更なし'}
                </span>
                {diffStats && hasChanges && (
                  <span className="vc__lines">+{diffStats.added} / −{diffStats.removed}</span>
                )}
              </>
            )}

            {diffTab === 'visual' && (
              <label className="vc__link" title="片方で画面を移動すると、もう片方も同じ画面に移ります">
                <input type="checkbox" checked={linked} onChange={(e) => setLinked(e.target.checked)} />
                画面を連動
              </label>
            )}

            <div className="vc__tabs motion-track" role="tablist">
              <SlidingIndicator active={diffTab} />
              {(['visual', 'code'] as const).map((t) => (
                <button
                  key={t}
                  className={`vc__tab${diffTab === t ? ' vc__tab--on' : ''}`}
                  onClick={() => setDiffTab(t)}
                  role="tab"
                  aria-selected={diffTab === t}
                  type="button"
                >
                  {t === 'visual' ? '画面' : 'コード'}
                </button>
              ))}
            </div>

            <button className="vc__close" onClick={() => setIsOpen(false)} type="button" aria-label="閉じる">
              ×
            </button>
          </header>

          {/*
            Above whichever body is showing, because what is being compared is
            not a property of how it is being looked at. Switching to the code
            tab used to leave the pickers behind with the frames.
          */}
          <div className="vc__heads">
            <SidePicker side={left.side} versions={versions} onSelect={left.select}
              otherVersionId={right.side.versionId} label="左" />
            <SidePicker side={right.side} versions={versions} onSelect={right.select}
              otherVersionId={left.side.versionId} label="右" />
          </div>

          {diffTab === 'visual' && (
            <div className="vc__pair motion-swap">
              <SideFrame side={left.side} hash={linked ? hash : null}
                onNavigate={(h) => { if (linked) setHash(h); }} />
              <SideFrame side={right.side} hash={linked ? hash : null}
                onNavigate={(h) => { if (linked) setHash(h); }} />
            </div>
          )}

          {diffTab === 'code' && (
            !a || !b ? (
              <p className="vc__empty">両方のバージョンを選ぶと差分が出ます。</p>
            ) : !hasChanges ? (
              <p className="vc__empty">変更なし</p>
            ) : fileDiffs.length > 0 ? (
              <CodeDiff files={fileDiffs} />
            ) : (
              <p className="vc__empty">差分なし</p>
            )
          )}
        </div>
      )}
    </>
  );
}
