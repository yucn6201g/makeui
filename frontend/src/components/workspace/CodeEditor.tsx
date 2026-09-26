import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { highlightLines } from '../../utils/editing/codeHighlight';
import { editability } from '../../utils/editing/sourceEdit';
import { splitHtmlToFiles, buildTree, type VFile, type TreeNode } from '../../utils/preview/virtualFs';
import { toProjectFiles } from '../../utils/preview/scaffold';
import { searchFiles, MAX_MATCHES, type SearchResult } from '../../utils/editing/codeSearch';
import { renderMarkdown } from '../../utils/editing/markdown';
import { SlidingIndicator } from '../common/SlidingIndicator';

interface CodeEditorProps {
  html: string | null;
  /**
   * Applies an edit to one file. Absent leaves the view read-only, which is
   * right for a version being read out of history.
   */
  onEditFile?: (path: string, content: string) => void;
}

/**
 * Above this, the file is shown but not edited.
 *
 * Editing drops the virtualisation — a textarea holds the whole file, and the
 * highlighted layer beneath it has to line up row for row, which it cannot do
 * while only a window of rows exists. Generated files are individually small;
 * this only bites on something pathological, and showing it read-only is a
 * better answer than an editor that stutters on every keystroke.
 */
const MAX_EDITABLE_LINES = 3000;

const LINE_H = 19;
const OVERSCAN = 20;

const LANG_LABEL: Record<string, string> = {
  html: 'HTML', css: 'CSS', js: 'JavaScript',
  jsx: 'JavaScript JSX', tsx: 'TypeScript JSX', ts: 'TypeScript',
  json: 'JSON', md: 'Markdown',
};
const MIME: Record<string, string> = {
  html: 'text/html;charset=utf-8',
  css: 'text/css;charset=utf-8',
  js: 'text/javascript;charset=utf-8',
  jsx: 'text/javascript;charset=utf-8',
  tsx: 'text/plain;charset=utf-8',
  ts: 'text/plain;charset=utf-8',
  json: 'application/json;charset=utf-8',
  md: 'text/markdown;charset=utf-8',
};

/** Open/closed folder glyph, so the tree reads at a glance like an editor explorer. */
function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg className="vsc__folder-icon" width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      {open ? (
        <path d="M1.5 3h4l1 1.5h7A1.5 1.5 0 0 1 15 6l-1.2 6.2a1.5 1.5 0 0 1-1.47 1.3H2.2A1.2 1.2 0 0 1 1 12.3V3.5A.5.5 0 0 1 1.5 3z" />
      ) : (
        <path d="M1.5 3h4l1 1.5h7a.5.5 0 0 1 .5.5v8a.5.5 0 0 1-.5.5h-12a.5.5 0 0 1-.5-.5v-9.5A.5.5 0 0 1 1.5 3z" />
      )}
    </svg>
  );
}

function FileIcon({ lang }: { lang: string }) {
  if (lang === 'css') {
    return (
      <svg className="vsc__icon vsc__icon--css" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <path fill="currentColor" d="M2 1h12l-1.1 12.3L8 15l-4.9-1.7L2 1zm9.6 3.2H6.2l.13 1.5h5.14l-.4 4.4-3.07.85-3.07-.85-.2-2.3h1.5l.1 1.16 1.67.45 1.68-.45.18-1.96H4.6l-.4-4.3h7.55l-.15 1.5z" />
      </svg>
    );
  }
  if (lang === 'js') {
    return (
      <svg className="vsc__icon vsc__icon--js" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <path fill="currentColor" d="M1 1h14v14H1V1zm7.5 11.2c.5.9 1.3 1.4 2.5 1.4 1.4 0 2.3-.75 2.3-1.9 0-1.06-.6-1.53-1.7-2l-.32-.14c-.55-.24-.79-.4-.79-.78 0-.31.24-.55.62-.55.37 0 .6.16.83.55l1.02-.66c-.43-.76-1.03-1.05-1.85-1.05-1.15 0-1.89.74-1.89 1.7 0 1.04.61 1.53 1.53 1.92l.32.14c.59.26.94.42.94.86 0 .37-.34.63-.88.63-.64 0-1-.33-1.28-.79l-1.06.62zm-4.3.13c.2.42.55.77 1.28.77.7 0 1.18-.37 1.18-1.35V7.6H5.4v4.14c0 .48-.2.6-.51.6-.33 0-.47-.23-.62-.5l-1.07.62z" />
      </svg>
    );
  }
  return (
    <svg className="vsc__icon vsc__icon--html" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path fill="currentColor" d="M2 1h12l-1.1 12.3L8 15l-4.9-1.7L2 1zm3.1 3.2l.13 1.5h6.06l-.15 1.5H5.5l.4 4.4 2.1.58 2.1-.58.15-1.63H8.6v-1.5h3.1l-.35 4.03L8 13.4l-3.35-.93-.23-2.6h1.5l.12 1.35L8 11.6l1.96-.53.1-1.17H4.36l-.4-4.4-.13-1.5h1.27z" />
    </svg>
  );
}

export function CodeEditor({ html, onEditFile }: CodeEditorProps) {
  const files = useMemo(() => {
    // React output is scaffolded into a real, runnable project (package.json,
    // vite config, entry html) so the tree can be copied straight into a repo.
    const title = html?.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim();
    return toProjectFiles(splitHtmlToFiles(html), title || 'MakeUI App');
  }, [html]);
  const tree = useMemo(() => buildTree(files), [files]);
  const signature = useMemo(() => files.map((f) => f.path).join('|'), [files]);

  const [openPaths, setOpenPaths] = useState<string[]>([]);
  const [activePath, setActivePath] = useState<string>('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Explorer width is user-adjustable, like a real editor.
  const [sidebarWidth, setSidebarWidth] = useState(220);
  const resizingRef = useRef(false);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizingRef.current) return;
      const host = document.querySelector('.vsc');
      const left = host ? host.getBoundingClientRect().left : 0;
      // 48px activity bar sits to the left of the explorer.
      setSidebarWidth(Math.min(Math.max(e.clientX - left - 48, 140), 520));
    };
    const onUp = () => {
      resizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const startResize = useCallback(() => {
    resizingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  /**
   * Which panel the sidebar is showing, or none.
   *
   * A tri-state rather than two booleans, because the sidebar holds one panel
   * at a time — that is what makes the activity bar a set of alternatives
   * rather than a row of independent switches, and two booleans would allow a
   * state the UI has no way to draw.
   */
  const [sidebar, setSidebar] = useState<'explorer' | 'search' | null>('explorer');
  const showExplorer = sidebar !== null;
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  /** The line a search result sent us to, marked until the next navigation. */
  const [markedLine, setMarkedLine] = useState<number | null>(null);
  const [mdPreview, setMdPreview] = useState(false);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [copied, setCopied] = useState(false);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });

  const scrollRef = useRef<HTMLDivElement>(null);
  // Mirrored so `openFileAt` can tell "already showing this file" without
  // rebuilding itself on every file change.
  const activePathRef = useRef('');

  /**
   * Put a line a third of the way down rather than at the very top.
   *
   * A match pinned to the first visible row has no context above it, and the
   * thing you usually want to see when a search lands is what encloses the
   * match — the function it is in, the block it belongs to.
   */
  const scrollToLine = useCallback((line: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const top = Math.max(0, (line - 1) * LINE_H - el.clientHeight / 3);
    el.scrollTop = top;
    setViewport((v) => ({ ...v, top }));
  }, []);
  // Mirror of openPaths so state updaters stay pure (StrictMode double-invokes them)
  const openPathsRef = useRef<string[]>([]);
  useEffect(() => {
    openPathsRef.current = openPaths;
  }, [openPaths]);
  useEffect(() => {
    activePathRef.current = activePath;
  }, [activePath]);

  /**
   * Opens the first file when the project changes — and only then.
   *
   * `files` is rebuilt on every document change, so depending on it made this
   * fire on every keystroke: the tabs closed, the view jumped back to
   * index.html, and the file being typed into disappeared. `signature` is the
   * list of paths, which changes when the project does and not when its
   * contents do. Editing a file does not change which files exist.
   */
  useEffect(() => {
    const paths = signature ? signature.split('|') : [];
    if (paths.length === 0) {
      setOpenPaths([]);
      setActivePath('');
      return;
    }
    // Adding a file — which a repair can do — should not close what is open.
    setOpenPaths((prev) => {
      const kept = prev.filter((p) => paths.includes(p));
      return kept.length > 0 ? kept : [paths[0]];
    });
    setActivePath((prev) => (paths.includes(prev) ? prev : paths[0]));
  }, [signature]);

  const active = files.find((f) => f.path === activePath) ?? null;

  /**
   * Unsaved text, per file.
   *
   * Held here and saved on demand rather than written through as you type. An
   * editor that saves every keystroke cannot offer "discard": by the time you
   * decide the change was wrong, it is already the document. Keeping the draft
   * separate is what makes both choices available — and it is why the tab can
   * show whether there is anything to decide about.
   *
   * Keyed by path so switching files mid-edit keeps both, which is the whole
   * point of having tabs.
   */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const editable = useMemo(
    () => (html && active && onEditFile ? editability(html, active.path) : { editable: false }),
    [html, active, onEditFile]
  );

  const text = activePath in drafts ? drafts[activePath] : active?.content ?? '';
  const dirtyPaths = useMemo(() => {
    const out = new Set<string>();
    for (const [path, draft] of Object.entries(drafts)) {
      const file = files.find((f) => f.path === path);
      if (file && file.content !== draft) out.add(path);
    }
    return out;
  }, [drafts, files]);

  // A new project has different files; drafts against the old ones mean nothing.
  useEffect(() => {
    setDrafts({});
  }, [signature]);

  const saveFile = useCallback(
    (path: string) => {
      setDrafts((prev) => {
        const draft = prev[path];
        if (draft === undefined) return prev;
        onEditFile?.(path, draft);
        const { [path]: _dropped, ...rest } = prev;
        return rest;
      });
    },
    [onEditFile]
  );

  const discardFile = useCallback((path: string) => {
    setDrafts((prev) => {
      const { [path]: _dropped, ...rest } = prev;
      return rest;
    });
  }, []);

  /** Asked before a dirty tab closes, so a close is never a silent discard. */
  const [closing, setClosing] = useState<string | null>(null);

  // Mirrored for the close handler, which is a stable callback and must not be
  // rebuilt every time a keystroke changes the dirty set.
  const dirtyRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    dirtyRef.current = dirtyPaths;
  }, [dirtyPaths]);

  /**
   * Ctrl/Cmd+S saves the file in front, and does not let the browser take it.
   *
   * Bound on the window rather than the textarea: the shortcut has to work when
   * focus is on a tab or the tree, which is where it will be after clicking
   * about — and the browser's own save dialog appearing over an editor is a
   * worse answer than nothing.
   */
  useEffect(() => {
    if (!onEditFile) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.key === 's' && (e.ctrlKey || e.metaKey))) return;
      e.preventDefault();
      if (activePath) saveFile(activePath);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onEditFile, activePath, saveFile]);

  const lines = useMemo(
    () => (active ? highlightLines(text, active.lang) : []),
    [active, text]
  );
  const editing = Boolean(editable.editable && lines.length <= MAX_EDITABLE_LINES);

  // Track the scroll viewport so only visible lines are rendered.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    /**
     * A zero height is the pane being hidden, not the editor being empty.
     *
     * The editor stays mounted while the preview tab is showing, so it spends
     * that time inside a `display: none` container and measures 0. Recording
     * that would leave the virtualised list rendering no lines on the frame the
     * tab comes back, before the ResizeObserver fires with the real height —
     * a blank editor for one frame, on exactly the switch this was all fixed
     * for. Keeping the last real height means it comes back already correct.
     */
    const measure = () =>
      setViewport((v) => (el.clientHeight === 0 ? v : { ...v, height: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [activePath]);

  useEffect(() => {
    // A search result asked for a line; honour it instead of the usual reset.
    const line = pendingLineRef.current;
    pendingLineRef.current = null;
    if (line !== null) {
      scrollToLine(line);
      return;
    }
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setViewport((v) => ({ ...v, top: 0 }));
  }, [activePath, scrollToLine]);

  /**
   * The line to scroll to once the file is open.
   *
   * A ref rather than state, and read by the effect that resets the scroll on a
   * file change — which is the effect it has to beat. Setting scrollTop from the
   * click handler would be undone a moment later by that reset, and the result
   * would be a search that opens the right file at the top of it.
   */
  const pendingLineRef = useRef<number | null>(null);

  const openFile = useCallback((path: string) => {
    setOpenPaths((prev) => (prev.includes(path) ? prev : [...prev, path]));
    setActivePath(path);
    setCursor({ line: 1, col: 1 });
    setMdPreview(false);
  }, []);

  /** Open a file at a line, which is what a search result is. */
  const openFileAt = useCallback((path: string, line: number) => {
    pendingLineRef.current = line;
    setMarkedLine(line);
    openFile(path);
    // Already open and already active: the effects below will not fire, so the
    // scroll has to happen here.
    if (path === activePathRef.current) scrollToLine(line);
  }, [openFile]);

  const results: SearchResult = useMemo(
    () => (sidebar === 'search' ? searchFiles(files, query.trim(), { caseSensitive, regex: useRegex }) : { files: [], total: 0, truncated: false }),
    [sidebar, files, query, caseSensitive, useRegex]
  );

  const forceCloseTab = useCallback((path: string) => {
    const prev = openPathsRef.current;
    const idx = prev.indexOf(path);
    const next = prev.filter((p) => p !== path);
    setOpenPaths(next);
    setActivePath((cur) =>
      cur === path ? next[Math.min(idx, next.length - 1)] ?? '' : cur
    );
  }, []);

  const closeTab = useCallback(
    (path: string, e: React.MouseEvent) => {
      e.stopPropagation();
      // Unsaved work is never thrown away by a click on an ×.
      if (dirtyRef.current.has(path)) {
        setClosing(path);
        return;
      }
      forceCloseTab(path);
    },
    [forceCloseTab]
  );

  /** Every folder path in the tree, for the collapse-all / expand-all control. */
  const folderPaths = useMemo(() => {
    const out: string[] = [];
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) if (n.children) { out.push(n.path); walk(n.children); }
    };
    walk(tree);
    return out;
  }, [tree]);

  const allCollapsed = folderPaths.length > 0 && folderPaths.every((p) => collapsed.has(p));
  const collapseAll = useCallback(() => setCollapsed(new Set(folderPaths)), [folderPaths]);
  const expandAll = useCallback(() => setCollapsed(new Set()), []);

  const toggleFolder = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleCopy = async () => {
    if (!active) return;
    try {
      await navigator.clipboard.writeText(active.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable */
    }
  };

  const handleDownload = (file: VFile) => {
    const blob = new Blob([file.content], { type: MIME[file.lang] });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.path.split('/').pop() ?? 'file.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (files.length === 0) {
    return (
      <div className="vsc">
        <TitleBar title="エディタ" />
        <div className="vsc__body vsc__body--empty">
          <div className="vsc__welcome">
            <p className="vsc__welcome-title">エディタ</p>
            <p className="vsc__welcome-sub">UIを生成するとソースがここに表示されます</p>
          </div>
        </div>
      </div>
    );
  }

  const start = Math.max(0, Math.floor(viewport.top / LINE_H) - OVERSCAN);
  const end = Math.min(lines.length, Math.ceil((viewport.top + viewport.height) / LINE_H) + OVERSCAN);
  // Editing renders every line: the caret layer holds the whole file, and a
  // window of coloured rows underneath it would drift out of register the
  // moment the two disagreed about how many lines exist.
  const visible = editing ? lines : lines.slice(start, end);
  const firstLine = editing ? 0 : start;
  const totalBytes = files.reduce((n, f) => n + f.content.length, 0);
  const crumbs = activePath ? activePath.split('/') : [];

  return (
    <div className="vsc">
      <TitleBar title={activePath || 'エディタ'} />
      <div className="vsc__body">
      {/* Activity bar */}
      <div className="vsc__activity motion-track">
        <SlidingIndicator active={sidebar} variant="rail" />
        <button
          className={`vsc__activity-btn${showExplorer ? ' vsc__activity-btn--active' : ''}`}
          onClick={() => setSidebar((v) => (v === 'explorer' ? null : 'explorer'))}
          title="エクスプローラー"
          aria-label="エクスプローラーの表示切替"
          aria-pressed={sidebar === 'explorer'}
          type="button"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M3 5.5A1.5 1.5 0 014.5 4h4l2 2.5h7A1.5 1.5 0 0119 8v10.5a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 013 18.5v-13z" />
          </svg>
        </button>
        <button
          className={`vsc__activity-btn${sidebar === 'search' ? ' vsc__activity-btn--active' : ''}`}
          onClick={() => setSidebar((v) => (v === 'search' ? null : 'search'))}
          title="検索 (プロジェクト全体)"
          aria-label="プロジェクト全体を検索"
          aria-pressed={sidebar === 'search'}
          type="button"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <circle cx="10.5" cy="10.5" r="6.5" />
            <path d="M15.5 15.5L21 21" />
          </svg>
        </button>
      </div>

      {/* Search */}
      {sidebar === 'search' && (
        <aside className="vsc__sidebar" aria-label="検索" style={{ width: sidebarWidth }}>
          <div className="vsc__sidebar-title">
            <span>検索</span>
          </div>
          <div className="vsc__search-box">
            <input
              className="vsc__search-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="検索"
              aria-label="検索語"
              autoFocus
              spellCheck={false}
            />
            <div className="vsc__search-opts">
              <button
                type="button"
                className={`vsc__search-opt${caseSensitive ? ' vsc__search-opt--on' : ''}`}
                onClick={() => setCaseSensitive((v) => !v)}
                title="大文字と小文字を区別"
                aria-pressed={caseSensitive}
              >
                Aa
              </button>
              <button
                type="button"
                className={`vsc__search-opt${useRegex ? ' vsc__search-opt--on' : ''}`}
                onClick={() => setUseRegex((v) => !v)}
                title="正規表現を使う"
                aria-pressed={useRegex}
              >
                .*
              </button>
            </div>
          </div>

          <div className="vsc__search-results">
            {results.error ? (
              /* A pattern that will not compile is its own answer. Shown as an
                 error rather than as an empty list, because those look the same
                 and only one of them means the project does not contain it. */
              <p className="vsc__search-note vsc__search-note--error" role="alert">
                正規表現として読めません: {results.error}
              </p>
            ) : !query.trim() ? (
              <p className="vsc__search-note">プロジェクト内の全ファイルを検索します。</p>
            ) : results.total === 0 ? (
              <p className="vsc__search-note">一致するものはありません。</p>
            ) : (
              <>
                <p className="vsc__search-note">
                  {results.total} 件 · {results.files.length} ファイル
                  {results.truncated && `（${MAX_MATCHES} 件で打ち切り。絞り込んでください）`}
                </p>
                {results.files.map((file) => (
                  <div key={file.path} className="vsc__search-file">
                    <div className="vsc__search-path" title={file.path}>
                      <span className="vsc__search-name">{file.path.split('/').pop()}</span>
                      <span className="vsc__search-dir">{file.path.split('/').slice(0, -1).join('/')}</span>
                      <span className="vsc__search-count">{file.matches.length}</span>
                    </div>
                    {file.matches.map((m, i) => (
                      <button
                        key={`${m.line}-${m.start}-${i}`}
                        type="button"
                        className="vsc__search-hit"
                        onClick={() => openFileAt(file.path, m.line)}
                        title={`${file.path}:${m.line}`}
                      >
                        <span className="vsc__search-line">{m.line}</span>
                        <span className="vsc__search-text">
                          {m.text.slice(0, m.start)}
                          <mark>{m.text.slice(m.start, m.end)}</mark>
                          {m.text.slice(m.end)}
                        </span>
                      </button>
                    ))}
                  </div>
                ))}
              </>
            )}
          </div>
        </aside>
      )}

      {/* Explorer */}
      {sidebar === 'explorer' && (
        <aside className="vsc__sidebar" aria-label="エクスプローラー" style={{ width: sidebarWidth }}>
          <div className="vsc__sidebar-title">
            <span>エクスプローラー</span>
            <button
              className="vsc__sidebar-action"
              onClick={allCollapsed ? expandAll : collapseAll}
              title={allCollapsed ? 'すべて展開' : 'フォルダーをすべて折りたたむ'}
              aria-label={allCollapsed ? 'すべて展開' : 'フォルダーをすべて折りたたむ'}
              type="button"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
                {allCollapsed ? (
                  <>
                    <path d="M2 5.5h12M2 10.5h12" />
                    <path d="M5.5 3L8 1l2.5 2M5.5 13L8 15l2.5-2" />
                  </>
                ) : (
                  <>
                    <path d="M2 8h12" />
                    <path d="M5.5 4.5L8 2l2.5 2.5M5.5 11.5L8 14l2.5-2.5" />
                  </>
                )}
              </svg>
            </button>
          </div>
          <div className="vsc__tree-root">
            <div className="vsc__tree-project">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M4 6l4 4 4-4z" />
              </svg>
              <span>UI-PROJECT</span>
            </div>
            <ul className="vsc__tree" role="tree">
              {tree.map((node) => (
                <TreeItem
                  key={node.path}
                  node={node}
                  depth={0}
                  activePath={activePath}
                  collapsed={collapsed}
                  onOpen={openFile}
                  onToggle={toggleFolder}
                />
              ))}
            </ul>
          </div>
          <div className="vsc__sidebar-foot">
            {files.length} ファイル · {(totalBytes / 1024).toFixed(1)} KB
          </div>
        </aside>
      )}
      {showExplorer && (
        <div
          className="vsc__resizer"
          onMouseDown={startResize}
          role="separator"
          aria-orientation="vertical"
          aria-label="エクスプローラーの幅を調整"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') setSidebarWidth((w) => Math.max(w - 20, 140));
            if (e.key === 'ArrowRight') setSidebarWidth((w) => Math.min(w + 20, 520));
          }}
        />
      )}

      {/* Editor */}
      <div className="vsc__main">
        <div className="vsc__tabs" role="tablist" aria-label="開いているファイル">
          {openPaths.map((path) => {
            const f = files.find((x) => x.path === path);
            if (!f) return null;
            const name = path.split('/').pop() ?? path;
            return (
              <div
                key={path}
                className={`vsc__tab${path === activePath ? ' vsc__tab--active' : ''}`}
                onClick={() => setActivePath(path)}
                role="tab"
                aria-selected={path === activePath}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setActivePath(path);
                  }
                }}
              >
                <FileIcon lang={f.lang} />
                <span className={`vsc__tab-name${dirtyPaths.has(path) ? ' vsc__tab-name--dirty' : ''}`}>
                  {name}
                </span>
                {/*
                  The dot replaces the close button while there is something to
                  lose, and turns back into one on hover — the arrangement every
                  editor uses, and the reason is that a × where a dot belongs
                  invites exactly the click that discards the work.
                */}
                <button
                  className={`vsc__tab-close${dirtyPaths.has(path) ? ' vsc__tab-close--dirty' : ''}`}
                  onClick={(e) => closeTab(path, e)}
                  aria-label={dirtyPaths.has(path) ? `${name} を閉じる（未保存）` : `${name} を閉じる`}
                  type="button"
                >
                  <svg className="vsc__tab-x" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <path d="M3 3l10 10M13 3L3 13" />
                  </svg>
                  <span className="vsc__tab-dot" aria-hidden="true" />
                </button>
              </div>
            );
          })}
          <div className="vsc__tabs-actions">
            {/*
              Markdown is the one language here whose rendered form is the point
              of it. A specification read as source is a table of pipes.
            */}
            {active?.lang === 'md' && (
              <button
                className={`vsc__tab-action${mdPreview ? ' vsc__tab-action--on' : ''}`}
                onClick={() => setMdPreview((v) => !v)}
                type="button"
                title={mdPreview ? 'ソースを表示' : 'プレビューを表示'}
                aria-pressed={mdPreview}
              >
                {mdPreview ? 'ソース' : 'プレビュー'}
              </button>
            )}
            <button className="vsc__tab-action" onClick={handleCopy} type="button" title="このファイルをコピー">
              {copied ? 'コピー済' : 'コピー'}
            </button>
            {active && (
              <button
                className="vsc__tab-action"
                onClick={() => handleDownload(active)}
                type="button"
                title="このファイルをダウンロード"
              >
                保存
              </button>
            )}
          </div>
        </div>

        {active ? (
          <>
            <div className="vsc__breadcrumb">
              {crumbs.map((c, i) => (
                <span key={i} className="vsc__crumb">
                  {i > 0 && <span className="vsc__crumb-sep">›</span>}
                  {c}
                </span>
              ))}
            </div>

            {mdPreview && active.lang === 'md' ? (
              /*
                The rendered document, from the draft rather than the saved file
                — the preview of an edit you have not saved yet is the edit.

                `renderMarkdown` escapes everything before it transforms
                anything and passes no raw HTML through, which is what makes
                this safe to hand to dangerouslySetInnerHTML. That decision
                lives in the renderer, with its tests; here it is only relied
                upon.
              */
              <div className="vsc__md-scroll">
                <div
                  className="vsc__md"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
                />
              </div>
            ) : (
            <div
              className="vsc__code-scroll"
              ref={scrollRef}
              onScroll={(e) => {
                // Read synchronously: React nulls currentTarget once the handler returns,
                // so a lazy state updater would see a detached event.
                const top = e.currentTarget.scrollTop;
                setViewport((v) => (v.top === top ? v : { ...v, top }));
              }}
            >
              <div className="vsc__code-sizer" style={{ height: lines.length * LINE_H }}>
                {/*
                  The caret layer.

                  A transparent textarea sitting exactly over the highlighted
                  rows: the browser owns selection, undo, IME composition and
                  keyboard behaviour, and the layer underneath supplies the
                  colour. Reimplementing any of that — particularly composition,
                  which every Japanese keystroke goes through — is how a
                  hand-rolled editor eats characters.

                  Alignment is not decorative here: if the metrics drift, the
                  caret sits beside the glyph it is meant to be inside. Both
                  layers take the same line height and the same left offset, and
                  the highlighted rows stop being virtualised while editing so
                  the two have the same number of lines.
                */}
                {editing && (
                  <textarea
                    className="vsc__input"
                    value={text}
                    spellCheck={false}
                    wrap="off"
                    aria-label={`${activePath} を編集`}
                    onChange={(e) => {
                      const value = e.target.value;
                      setDrafts((prev) => ({ ...prev, [activePath]: value }));
                    }}
                    onScroll={(e) => {
                      // The textarea must not scroll on its own — the container does.
                      e.currentTarget.scrollTop = 0;
                      e.currentTarget.scrollLeft = 0;
                    }}
                    onKeyDown={(e) => {
                      // Tab indents rather than leaving the editor. Without this the
                      // first Tab in a code pane moves focus to the next control,
                      // which in an editor reads as the key being broken.
                      if (e.key !== 'Tab') return;
                      e.preventDefault();
                      const el = e.currentTarget;
                      const { selectionStart: s, selectionEnd: end, value } = el;
                      const next = `${value.slice(0, s)}  ${value.slice(end)}`;
                      setDrafts((prev) => ({ ...prev, [activePath]: next }));
                      requestAnimationFrame(() => {
                        el.selectionStart = el.selectionEnd = s + 2;
                      });
                    }}
                    onSelect={(e) => {
                      const el = e.currentTarget;
                      const upto = el.value.slice(0, el.selectionStart).split('\n');
                      setCursor({ line: upto.length, col: upto[upto.length - 1].length + 1 });
                    }}
                  />
                )}
                <div
                  className={`vsc__code-window${editing ? ' vsc__code-window--under' : ''}`}
                  style={{ transform: editing ? undefined : `translateY(${start * LINE_H}px)` }}
                >
                  {visible.map((toks, i) => {
                    const n = firstLine + i + 1;
                    return (
                      <div
                        key={n}
                        className={`vsc__row${n === cursor.line ? ' vsc__row--active' : ''}${
                          n === markedLine ? ' vsc__row--found' : ''
                        }`}
                        onClick={() => {
                          const sel = window.getSelection();
                          setCursor({ line: n, col: (sel?.anchorOffset ?? 0) + 1 });
                        }}
                      >
                        <span className="vsc__ln">{n}</span>
                        <span className="vsc__lc">
                          {toks.length === 0
                            ? ' '
                            : toks.map((t, j) => (
                                <span key={j} className={t.c ? `t-${t.c}` : undefined}>
                                  {t.t}
                                </span>
                              ))}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
            )}

            <div className="vsc__status">
              <span className="vsc__status-item">{activePath}</span>
              <span className="vsc__status-spacer" />
              <span className="vsc__status-item">
                行 {cursor.line}、列 {cursor.col}
              </span>
              <span className="vsc__status-item">スペース: 2</span>
              <span className="vsc__status-item">UTF-8</span>
              <span className="vsc__status-item">LF</span>
              <span className="vsc__status-item">{LANG_LABEL[active.lang]}</span>
              {/* Says which of the three states this file is in, because "why
                  can I not type here" is otherwise a guess. */}
              <span className="vsc__status-item vsc__status-item--mode">
                {editing
                  ? '編集可'
                  : editable.editable
                    ? `読み取り専用（${MAX_EDITABLE_LINES}行超）`
                    : '読み取り専用'}
              </span>
            </div>
            {!editable.editable && editable.reason && onEditFile && (
              <p className="vsc__readonly-note">{editable.reason}</p>
            )}

            {dirtyPaths.has(activePath) && (
              <div className="vsc__dirty-bar" role="status">
                <span>未保存の変更があります</span>
                <button type="button" className="vsc__dirty-save" onClick={() => saveFile(activePath)}>
                  保存（{navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl+'}S）
                </button>
                <button type="button" className="vsc__dirty-discard" onClick={() => discardFile(activePath)}>
                  破棄
                </button>
              </div>
            )}

            {closing && (
              /*
                Three ways out, and cancel is the default one the Escape key and
                the backdrop both reach. A two-button dialog would force a choice
                between saving and losing the work for someone who only meant to
                tidy their tabs.
              */
              <div
                className="vsc__dialog-backdrop"
                role="presentation"
                onClick={() => setClosing(null)}
              >
                <div
                  className="vsc__dialog"
                  role="alertdialog"
                  aria-modal="true"
                  aria-labelledby="vsc-dialog-title"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => { if (e.key === 'Escape') setClosing(null); }}
                >
                  <p className="vsc__dialog-title" id="vsc-dialog-title">
                    {closing.split('/').pop()} の変更を保存しますか？
                  </p>
                  <p className="vsc__dialog-body">保存しない場合、この変更は失われます。</p>
                  <div className="vsc__dialog-actions">
                    <button
                      type="button"
                      className="vsc__dialog-btn vsc__dialog-btn--primary"
                      autoFocus
                      onClick={() => { saveFile(closing); forceCloseTab(closing); setClosing(null); }}
                    >
                      保存して閉じる
                    </button>
                    <button
                      type="button"
                      className="vsc__dialog-btn"
                      onClick={() => { discardFile(closing); forceCloseTab(closing); setClosing(null); }}
                    >
                      保存しない
                    </button>
                    <button type="button" className="vsc__dialog-btn" onClick={() => setClosing(null)}>
                      キャンセル
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="vsc__welcome">
            <p className="vsc__welcome-title">開いているファイルがありません</p>
            <p className="vsc__welcome-sub">左のエクスプローラーからファイルを選択してください</p>
          </div>
        )}
      </div>
      </div>
    </div>
  );
}

/**
 * The window's title bar.
 *
 * The preview pane reads as a browser because it draws Chrome's tab strip and
 * toolbar; this pane drew VS Code's activity bar, sidebar, tabs and breadcrumb
 * and then stopped — so it filled its pane edge to edge and read as a region of
 * the app rather than as an application in a window. The two panes are the same
 * kind of claim and should be framed the same way.
 *
 * VS Code's own title bar: #3c3c3c, the active file centred, nothing else. No
 * traffic lights, for the same reason the Chrome chrome next door has none —
 * neither is pretending to be an operating system.
 */
function TitleBar({ title }: { title: string }) {
  return (
    <div className="vsc__titlebar">
      <span className="vsc__titlebar-title">{title}</span>
    </div>
  );
}

interface TreeItemProps {
  node: TreeNode;
  depth: number;
  activePath: string;
  collapsed: Set<string>;
  onOpen: (path: string) => void;
  onToggle: (path: string) => void;
}

function TreeItem({ node, depth, activePath, collapsed, onOpen, onToggle }: TreeItemProps) {
  const isFolder = !!node.children;
  const isCollapsed = collapsed.has(node.path);
  const pad = 8 + depth * 12;

  if (isFolder) {
    return (
      <li role="none">
        <button
          className="vsc__tree-row vsc__tree-row--folder"
          style={{ paddingLeft: pad }}
          onClick={() => onToggle(node.path)}
          role="treeitem"
          aria-expanded={!isCollapsed}
          type="button"
        >
          <svg
            className={`vsc__chevron${isCollapsed ? '' : ' vsc__chevron--open'}`}
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M6 4l4 4-4 4z" />
          </svg>
          <FolderIcon open={!isCollapsed} />
          <span className="vsc__tree-name">{node.name}</span>
        </button>
        {!isCollapsed && (
          // Guide line sits under this folder's chevron, marking the nesting level.
          <ul
            className="vsc__tree"
            role="group"
            style={{ ['--vsc-guide-left' as string]: `${pad + 5}px` }}
          >
            {node.children!.map((child) => (
              <TreeItem
                key={child.path}
                node={child}
                depth={depth + 1}
                activePath={activePath}
                collapsed={collapsed}
                onOpen={onOpen}
                onToggle={onToggle}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  return (
    <li role="none">
      <button
        className={`vsc__tree-row${node.path === activePath ? ' vsc__tree-row--active' : ''}`}
        style={{ paddingLeft: pad + 12 }}
        onClick={() => onOpen(node.path)}
        role="treeitem"
        aria-selected={node.path === activePath}
        type="button"
      >
        <FileIcon lang={node.file?.lang ?? 'html'} />
        <span className="vsc__tree-name">{node.name}</span>
      </button>
    </li>
  );
}
