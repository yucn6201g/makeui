import { useEffect, useMemo, useRef, useState } from 'react';
import { useProjects, type Project } from '../hooks/useProjects';
import { ProjectThumbnail } from './ProjectThumbnail';
import {
  frameworkCounts,
  projectKind,
  tabOf,
  visibleProjects,
  type ProjectTab,
  type FrameworkFilter,
  type SortKey,
  type SortDirection,
} from '../utils/projectFilter';
import { useAuth } from '../auth/AuthProvider';
import { ROLE_LABELS } from '../utils/shareRoles';
import { AdminPanel } from './AdminPanel';
import { UsageMenu } from './UsageMenu';
import { useUsage } from '../hooks/useUsage';
import { Dropdown } from './Dropdown';
import { localPartOf } from '../utils/displayName';
import { activeJobProjectIds } from '../utils/activeJob';
import { SlidingIndicator } from './SlidingIndicator';
import { useFlip, EXITING_ATTR } from '../hooks/useFlip';
import { usePresence, usePresenceList } from '../hooks/usePresence';

/**
 * What each output format is called on a card.
 *
 * A map rather than a ternary because the ternary was the bug: `kind === 'react'
 * ? 'React' : 'HTML'` names two formats out of four, so Vue and Svelte projects
 * were both announced as HTML — a format the app no longer even generates.
 * `HTML` survives only as the fallback for documents stored before the project
 * formats existed.
 */
const KIND_LABELS: Record<string, string> = {
  react: 'React',
  vue: 'Vue',
};

interface ProjectListProps {
  onOpenProject: (project: Project) => void;
  onNewProject: (project: Project) => void;
}

/** What the list can be ordered by, and what each is called. */
const SORT_KEYS: { value: SortKey; label: string }[] = [
  { value: 'recent', label: '更新順' },
  { value: 'tokens', label: 'トークン数' },
  { value: 'requests', label: '生成回数' },
];

/** The framework tabs, in the order the formats were added. */
const FRAMEWORK_TABS: { value: FrameworkFilter; label: string }[] = [
  { value: 'all', label: 'すべて' },
  { value: 'react', label: 'React' },
  { value: 'vue', label: 'Vue' },
];

export function ProjectList({ onOpenProject, onNewProject }: ProjectListProps) {
  const { userEmail, logout, isAdmin } = useAuth();
  const { projects, loading, error, fetchProjects, createProject, archiveProject, archiveProjects, favouriteProject, deleteProject, deleteProjects, fetchProjectPreview } =
    useProjects();
  /*
   * The monthly ledger, which is a different question from the totals below and
   * is shown as such. The list did not fetch it before — the panel had nothing
   * to say about limits — so this is a new call on this screen, made once.
   */
  const { usage: ledger, refresh: refreshLedger } = useUsage();
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const [framework, setFramework] = useState<FrameworkFilter>('all');
  /*
   * Its own axis, not a fourth framework tab. "React" and "favourite" answer
   * different questions, and one control for both would mean you could never
   * ask for a starred Vue project.
   */
  const [favouriteOnly, setFavouriteOnly] = useState(false);
  /** プロジェクト, 共有 or アーカイブ — see `tabOf` for which a project is on. */
  const [tab, setTab] = useState<ProjectTab>('active');
  const showArchive = tab === 'archive';
  /**
   * The project a second click would destroy.
   *
   * Confirmation is inline on the card rather than a `window.confirm`: the
   * dialog appears over a page that no longer shows which project it is about,
   * and this is the one action in the app with nothing behind it — the record,
   * the stored document and the thumbnail all go.
   */
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  /*
   * Choosing several projects to act on at once.
   *
   * A mode rather than checkboxes that are always there: a card's whole surface
   * opens the project, and a checkbox permanently in its corner would put two
   * different outcomes a few pixels apart on every card for the one visit in
   * twenty that wants them. In the mode, the card's surface selects instead of
   * opening, and the per-card controls step aside so a click has one meaning.
   */
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  /** The second click that would destroy every selected project. */
  const [confirmingBulkDelete, setConfirmingBulkDelete] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  /*
   * Which projects this browser has a run in flight for.
   *
   * Polled rather than read once: a person opens the list, starts nothing, and
   * a run they left going finishes while they are looking at it — a card that
   * said 「生成中」 for the rest of the visit would be worse than one that never
   * said it. Six seconds is slower than the workspace's own poll and far faster
   * than anyone's patience for a stale badge.
   *
   * Local to this browser. A run started elsewhere is not marked here, which is
   * the honest limit of reading job records the server keeps no index of.
   */
  const [busyProjects, setBusyProjects] = useState<Set<string>>(() => activeJobProjectIds());
  useEffect(() => {
    const tick = () => setBusyProjects(activeJobProjectIds());
    const timer = setInterval(tick, 6000);
    // And immediately on returning to the tab, which is the moment somebody is
    // most likely to be checking.
    window.addEventListener('focus', tick);
    return () => { clearInterval(timer); window.removeEventListener('focus', tick); };
  }, []);
  const [sortKey, setSortKey] = useState<SortKey>('recent');
  /*
   * Descending by default, because both measures are "how much" and the
   * question people bring to them is which projects cost the most.
   */
  const [sortDir, setSortDir] = useState<SortDirection>('desc');

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  const archivedCount = useMemo(
    () => projects.filter((p) => p.archivedAt).length,
    [projects]
  );
  const counts = useMemo(() => frameworkCounts(projects, tab), [projects, tab]);
  const sharedCount = useMemo(() => projects.filter((p) => tabOf(p) === 'shared').length, [projects]);
  /*
   * Counted over the ACTIVE list only. Archiving clears the star — the service
   * enforces that an archived project is never a favourite — so including the
   * archive would count a set that is always empty.
   */
  const favouriteCount = useMemo(
    () => projects.filter((p) => p.favouritedAt && !p.archivedAt).length,
    [projects]
  );
  const shown = useMemo(
    () =>
      visibleProjects(projects, {
        query,
        framework,
        favourite: favouriteOnly,
        tab,
        sort: { key: sortKey, direction: sortDir },
      }),
    [projects, query, framework, favouriteOnly, tab, sortKey, sortDir]
  );
  /*
   * A filter that hides everything is not the same as an empty account, and the
   * two used to look alike because there was only ever one of them.
   */
  const filtering = query.trim().length > 0 || framework !== 'all' || favouriteOnly;

  /*
   * The grid moves rather than redraws: a card filtered out fades where it
   * stood, the rest travel to their new places, and new ones rise in — for a
   * tab, a framework, a search, a sort or a deletion alike. See useFlip.
   */
  const gridRef = useRef<HTMLDivElement>(null);
  useFlip(gridRef);
  const cards = usePresenceList(shown, (p) => p.projectId);
  const newCard = usePresence(tab === 'active' && !selecting);
  const bulkBar = usePresence(selecting);

  const handleNew = async () => {
    setCreating(true);
    const project = await createProject('Untitled');
    setCreating(false);
    if (project) {
      onNewProject(project);
    }
  };

  const handleArchive = async (e: React.MouseEvent, projectId: string, archived: boolean) => {
    e.stopPropagation();
    await archiveProject(projectId, archived);
  };

  const handleFavourite = async (e: React.MouseEvent, projectId: string, favourite: boolean) => {
    e.stopPropagation();
    await favouriteProject(projectId, favourite);
  };

  const handleDelete = async (e: React.MouseEvent, projectId: string) => {
    e.stopPropagation();
    setConfirmingDelete(null);
    await deleteProject(projectId);
  };

  /*
   * The selection, restricted to what is on screen.
   *
   * Filtering after selecting would otherwise leave projects chosen that are no
   * longer visible, and "12件をアーカイブ" would act on some the person cannot
   * see. Every count and every action reads this, never `selected` directly, so
   * a hidden choice is simply not part of what happens.
   */
  const selectedShown = shown.filter((p) => selected.has(p.projectId));

  const leaveSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
    setConfirmingBulkDelete(false);
  };

  const toggleSelected = (projectId: string) => {
    setConfirmingBulkDelete(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  const allShownSelected = shown.length > 0 && selectedShown.length === shown.length;
  const toggleAllShown = () => {
    setConfirmingBulkDelete(false);
    setSelected(allShownSelected ? new Set() : new Set(shown.map((p) => p.projectId)));
  };

  const runBulk = async (action: 'archive' | 'restore' | 'delete') => {
    const ids = selectedShown.map((p) => p.projectId);
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      if (action === 'delete') await deleteProjects(ids);
      else await archiveProjects(ids, action === 'archive');
    } finally {
      setBulkBusy(false);
      leaveSelecting();
    }
  };

  // Escape leaves the mode, the way it leaves every other transient state here.
  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') leaveSelecting(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selecting]);

  /*
   * What the direction means, in the words of the thing being ordered.
   *
   * 「多い順」 is right for a count and wrong for a date: a list ordered by
   * 更新順 is newest-first, not most-first. One label for both would make the
   * control say something untrue half the time it is used.
   */
  const directionLabel =
    sortKey === 'recent'
      ? sortDir === 'desc' ? '新しい順' : '古い順'
      : sortDir === 'desc' ? '多い順' : '少ない順';

  /** Compact token counts: a project can run to hundreds of thousands. */
  const formatTokens = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${Math.round(n / 1000)}k`;
    return String(n);
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="project-list">
      <header className="project-list__header">
        <h1 className="project-list__logo">MakeUI</h1>
        <div className="project-list__user">
          <UsageMenu
            /* The server's answer, with the local part standing in until it
               arrives — see utils/displayName.ts. */
            name={ledger?.displayName || localPartOf(userEmail)}
            group={ledger?.group}
            limits={
              ledger && {
                tokensUsed: ledger.tokensUsed,
                tokensLimit: ledger.tokensLimit,
                requestsUsed: ledger.requestsUsed,
                cost: ledger.cost,
                costEstimated: ledger.costEstimated,
                groupBudget: ledger.groupBudget,
              }
            }
            // An administrator can change a limit while the page is open, and
            // the number people come here to check is the one that just moved.
            onOpen={refreshLedger}
          />
          {isAdmin && <AdminPanel />}
          <button onClick={logout} className="app__header-btn project-list__logout" type="button">Logout</button>
        </div>
      </header>

      <div className="project-list__body">
        <div className="project-list__toolbar">
          <div className="project-list__tabs motion-track" role="tablist" aria-label="表示するプロジェクト">
            <SlidingIndicator active={tab} variant="underline" />
            {([
              ['active', 'プロジェクト', 0],
              // Projects this account shared, and projects shared with it — both sides.
              ['shared', '共有', sharedCount],
            ] as const).map(([key, label, count]) => (
              <button
                key={key}
                className={`project-list__tab${tab === key ? ' project-list__tab--on' : ''}`}
                onClick={() => { setTab(key); setConfirmingDelete(null); leaveSelecting(); }}
                role="tab"
                aria-selected={tab === key}
                type="button"
              >
                {label}
                {count > 0 && <span className="project-list__tab-count">{count}</span>}
              </button>
            ))}
            <button
              className={`project-list__tab${showArchive ? ' project-list__tab--on' : ''}`}
              onClick={() => { setTab('archive'); setConfirmingDelete(null); leaveSelecting(); }}
              role="tab"
              aria-selected={showArchive}
              type="button"
            >
              アーカイブ
              {archivedCount > 0 && <span className="project-list__tab-count">{archivedCount}</span>}
            </button>
          </div>
          {/*
            Where the blue 「+ 新規プロジェクト」 was. It did exactly what the card
            at the head of the grid does, one line above it — two controls for one
            action, and the louder of them was the redundant one.
          */}
          {shown.length > 0 && (
            <button
              className={`project-list__select-toggle${selecting ? ' project-list__select-toggle--on' : ''}`}
              onClick={() => (selecting ? leaveSelecting() : setSelecting(true))}
              aria-pressed={selecting}
              type="button"
            >
              {selecting ? '選択を終了' : '選択'}
            </button>
          )}
        </div>

        {/*
          What can be done with the selection, above the list it acts on.

          The archive tab offers restore and delete; the active tab offers only
          archive — the same rule the cards follow, because deleting something
          that has not been put away first is the one mistake with nothing
          behind it, and the server refuses it anyway.
        */}
        {bulkBar.mounted && (
          <div className="project-list__bulk" role="region" aria-label="まとめて操作" data-state={bulkBar.state}>
            <span className="project-list__bulk-count" role="status">
              {selectedShown.length}件を選択中
            </span>
            <button className="project-list__bulk-link" onClick={toggleAllShown} type="button">
              {allShownSelected ? '選択を解除' : `表示中の${shown.length}件をすべて選択`}
            </button>
            <div className="project-list__bulk-actions">
              {!showArchive ? (
                <button
                  className="project-list__bulk-btn"
                  onClick={() => runBulk('archive')}
                  disabled={selectedShown.length === 0 || bulkBusy}
                  type="button"
                >
                  アーカイブ
                </button>
              ) : confirmingBulkDelete ? (
                /*
                  Stated as a count and as a consequence, next to the button that
                  does it. Destroying twelve projects at once is the largest
                  irreversible thing this screen can do.
                */
                <>
                  <span className="project-list__bulk-warn" role="alert">
                    {selectedShown.length}件を完全に削除します。元に戻せません
                  </span>
                  <button
                    className="project-list__bulk-btn project-list__bulk-btn--danger"
                    onClick={() => runBulk('delete')}
                    disabled={bulkBusy}
                    type="button"
                  >
                    削除する
                  </button>
                  <button className="project-list__bulk-link" onClick={() => setConfirmingBulkDelete(false)} type="button">
                    やめる
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="project-list__bulk-btn"
                    onClick={() => runBulk('restore')}
                    disabled={selectedShown.length === 0 || bulkBusy}
                    type="button"
                  >
                    復元
                  </button>
                  <button
                    className="project-list__bulk-btn project-list__bulk-btn--danger"
                    onClick={() => setConfirmingBulkDelete(true)}
                    disabled={selectedShown.length === 0 || bulkBusy}
                    type="button"
                  >
                    完全に削除
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        <div className="project-list__filters">
          <div className="project-list__search">
            <svg
              className="project-list__search-icon"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              className="project-list__search-input"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="プロジェクト名で検索"
              aria-label="プロジェクト名で検索"
            />
            {query && (
              <button
                className="project-list__search-clear"
                onClick={() => setQuery('')}
                aria-label="検索条件をクリア"
                type="button"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>

          <div className="project-list__segmented motion-track" role="group" aria-label="フレームワークで絞り込む">
            <SlidingIndicator active={framework} />
            {FRAMEWORK_TABS.map((tab) => (
              <button
                key={tab.value}
                className={`project-list__segment${framework === tab.value ? ' project-list__segment--on' : ''}`}
                onClick={() => setFramework(tab.value)}
                aria-pressed={framework === tab.value}
                type="button"
              >
                {tab.label}
                <span className="project-list__segment-count">{counts[tab.value]}</span>
              </button>
            ))}
          </div>

          {/*
            Its own control, deliberately outside the framework segments.
            Putting it among them would read as a fifth format and would make
            "starred Vue projects" unaskable. Hidden on the archive, where the
            star is cleared on the way in and the count is always zero.
          */}
          {!showArchive && (
            <button
              className={`project-list__favourite-filter${favouriteOnly ? ' project-list__favourite-filter--on' : ''}`}
              onClick={() => setFavouriteOnly((v) => !v)}
              aria-pressed={favouriteOnly}
              type="button"
              title={favouriteOnly ? 'すべてのプロジェクトを表示' : 'お気に入りだけを表示'}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill={favouriteOnly ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3l2.7 5.5 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.8 1-6.1L3.2 9.4l6.1-.9z" />
              </svg>
              お気に入り
              <span className="project-list__segment-count">{favouriteCount}</span>
            </button>
          )}

          <div className="project-list__sort">
            {/* The label is the menu's own now, the way the composer's are. */}
            <Dropdown
              label="並び替え"
              value={sortKey}
              onChange={(id) => setSortKey(id as SortKey)}
              options={SORT_KEYS.map((s) => ({ id: s.value, label: s.label }))}
            />
            {/*
              Every key, 更新順 included. It was hidden there because the list
              returned the server's order untouched — which is descending by
              `updatedAt`, so the one direction the list could not be reversed
              was its own default.
            */}
            {(
              <button
                className="project-list__sort-dir"
                onClick={() => setSortDir(sortDir === 'desc' ? 'asc' : 'desc')}
                type="button"
                aria-label={`${directionLabel}で並んでいます。切り替える`}
                title={directionLabel}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  {sortDir === 'desc' ? (
                    <>
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <polyline points="19 12 12 19 5 12" />
                    </>
                  ) : (
                    <>
                      <line x1="12" y1="19" x2="12" y2="5" />
                      <polyline points="5 12 12 5 19 12" />
                    </>
                  )}
                </svg>
                {directionLabel}
              </button>
            )}
          </div>
        </div>

        {error && (
          <div className="project-list__error" role="alert">
            {error}
            <button onClick={() => fetchProjects()} type="button">再試行</button>
          </div>
        )}

        {/* While the first load is in flight, show skeleton cards in the grid itself.
            Rendering a loading line above a grid that already had the "new project"
            card in it left the page looking half-built. */}
        <div className="project-list__grid" ref={gridRef}>
          {/* New project card. Only on プロジェクト — nothing is created in the archive, and a new project is nobody else's yet. */}
          {newCard.mounted && (
            <button
              className="project-list__card project-list__card--new"
              onClick={handleNew}
              type="button"
              disabled={creating || newCard.closing}
              {...(newCard.closing ? { [EXITING_ATTR]: '' } : {})}
            >
              <div className="project-list__card-icon">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </div>
              <span className="project-list__card-label">新規プロジェクト</span>
            </button>
          )}

          {loading && projects.length === 0 && (
            <>
              {[0, 1, 2, 3].map((i) => (
                <div className="project-list__card project-list__card--skeleton" key={i} aria-hidden="true">
                  <div className="project-list__card-preview" />
                  <div className="project-list__card-info">
                    <span className="project-list__skeleton-line" />
                    <span className="project-list__skeleton-line project-list__skeleton-line--short" />
                  </div>
                </div>
              ))}
              <span className="project-list__sr-status" role="status">プロジェクトを読み込み中...</span>
            </>
          )}

          {cards.map(({ item: project, exiting }) => {
            const kind = projectKind(project);
            const running = busyProjects.has(project.projectId);
            const archived = Boolean(project.archivedAt);
            const favourite = Boolean(project.favouritedAt);
            /*
             * What this account may do to it. A viewer gets neither the star nor
             * the archive — both write the project, which is the owner's and the
             * other members' as much as theirs.
             */
            const role = project.access?.role ?? 'owner';
            const canWrite = role !== 'view';
            const confirming = confirmingDelete === project.projectId;
            const isSelected = selecting && selected.has(project.projectId);
            const activate = () => (selecting ? toggleSelected(project.projectId) : onOpenProject(project));
            return (
            <div
              key={project.projectId}
              className={`project-list__card${archived ? ' project-list__card--archived' : ''}${running ? ' project-list__card--running' : ''}${isSelected ? ' project-list__card--selected' : ''}`}
              onClick={activate}
              role={selecting ? 'checkbox' : 'button'}
              aria-checked={selecting ? isSelected : undefined}
              tabIndex={exiting ? -1 : 0}
              aria-hidden={exiting || undefined}
              {...(exiting ? { [EXITING_ATTR]: '' } : {})}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || (selecting && e.key === ' ')) {
                  e.preventDefault();
                  activate();
                }
              }}
            >
              {selecting && (
                <span className={`project-list__check${isSelected ? ' project-list__check--on' : ''}`} aria-hidden="true">
                  {isSelected && (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </span>
              )}
              <div className="project-list__card-preview">
                <ProjectThumbnail
                  html={project.lastHtml}
                  title={project.name}
                  projectId={project.projectId}
                  hasDocument={project.hasDocument}
                  fetchHtml={fetchProjectPreview}
                />
              </div>
              <div className="project-list__card-info">
                <div className="project-list__card-line">
                  <span className="project-list__card-name">{project.name}</span>
                  {/*
                    A run outlives this screen, so the list is where somebody
                    goes to see whether one is still going — and it said nothing.
                    From this browser's own job records, which the workspace
                    already keeps per project: the alternative is a request per
                    card to a server that keeps no index of running jobs.
                  */}
                  {running && (
                    <span className="project-list__running" title="生成中です">
                      <span className="project-list__running-dot" aria-hidden="true" />
                      生成中
                    </span>
                  )}
                  {kind && (
                    <span className={`project-list__kind project-list__kind--${kind}`}>
                      {/*
                        `html` has no entry: it is not a format anything emits
                        any more, and the stored projects that carry it predate
                        the choice. It falls through to the raw key, which reads
                        as 「html」 — accurate for those, and the reason the
                        fallback is the key rather than a literal 'HTML': a
                        format added later and left out of the table would
                        otherwise announce itself as HTML, which is a wrong label
                        where the key is merely an unpolished one.
                      */}
                      {KIND_LABELS[kind] ?? kind.toUpperCase()}
                    </span>
                  )}
                </div>
                <div className="project-list__card-meta">
                  <span className="project-list__card-date">{formatDate(project.updatedAt || project.createdAt)}</span>
                  {(project.requestCount ?? 0) > 0 && (
                    <>
                      <span className="project-list__meta-sep" aria-hidden="true" />
                      <span title="このプロジェクトで実行した生成・変更の回数">
                        {project.requestCount}回
                      </span>
                      <span className="project-list__meta-sep" aria-hidden="true" />
                      <span title={`累計 ${(project.totalTokens ?? 0).toLocaleString()} トークン`}>
                        {formatTokens(project.totalTokens ?? 0)} tok
                      </span>
                    </>
                  )}
                </div>
                {/*
                  Whose it is and what this account may do, on the 共有 tab's
                  cards — the tab holds both directions, and they look alike.
                */}
                {role !== 'owner' ? (
                  <div className="project-list__card-share" title={project.access?.via === 'group' ? 'グループで共有されています' : undefined}>
                    {project.access?.ownerName} さんから共有
                    <span className={`project-list__role project-list__role--${role}`}>{ROLE_LABELS[role]}</span>
                  </div>
                ) : project.sharedAt ? (
                  <div className="project-list__card-share">共有中</div>
                ) : null}
              </div>

              {/*
                The star stays visible when it is on — that is the whole point
                of it — and appears on hover when it is off, like the other card
                controls. An archived project has no star: putting something
                away and marking it as wanted say opposite things.
              */}
              {!archived && !selecting && canWrite && (
                <button
                  className={`project-list__card-star${favourite ? ' project-list__card-star--on' : ''}`}
                  onClick={(e) => handleFavourite(e, project.projectId, !favourite)}
                  aria-label={`${project.name} を${favourite ? 'お気に入りから外す' : 'お気に入りに追加'}`}
                  aria-pressed={favourite}
                  title={favourite ? 'お気に入りから外す' : 'お気に入り'}
                  type="button"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill={favourite ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="12 2.6 15.1 9 22 10 17 14.9 18.2 21.8 12 18.5 5.8 21.8 7 14.9 2 10 8.9 9" />
                  </svg>
                </button>
              )}

              {/* The active list archives; only the archive destroys. */}
              {selecting || !canWrite ? null : !archived ? (
                <button
                  className="project-list__card-action"
                  onClick={(e) => handleArchive(e, project.projectId, true)}
                  aria-label={`${project.name} をアーカイブ`}
                  title="アーカイブ"
                  type="button"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="4" width="18" height="4" rx="1" />
                    <path d="M5 8v11a1 1 0 001 1h12a1 1 0 001-1V8" />
                    <line x1="10" y1="13" x2="14" y2="13" />
                  </svg>
                </button>
              ) : (
                <div className="project-list__card-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="project-list__card-action"
                    onClick={(e) => handleArchive(e, project.projectId, false)}
                    aria-label={`${project.name} を復元`}
                    title="復元"
                    type="button"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 12a9 9 0 109-9 9 9 0 00-6.36 2.64L3 8" />
                      <polyline points="3 3 3 8 8 8" />
                    </svg>
                  </button>
                  <button
                    className="project-list__card-action project-list__card-action--danger"
                    onClick={(e) => { e.stopPropagation(); setConfirmingDelete(project.projectId); }}
                    aria-label={`${project.name} を完全に削除`}
                    title="完全に削除"
                    type="button"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                    </svg>
                  </button>
                </div>
              )}

              {/* Over the card, so the name it is asking about is still on screen. */}
              {confirming && (
                <div
                  className="project-list__confirm"
                  onClick={(e) => e.stopPropagation()}
                  role="alertdialog"
                  aria-label={`${project.name} を完全に削除しますか`}
                >
                  <p className="project-list__confirm-text">
                    <strong>{project.name}</strong> を完全に削除します。
                    <br />
                    生成した画面もコードも元に戻せません。
                  </p>
                  <div className="project-list__confirm-actions">
                    <button
                      className="project-list__confirm-cancel"
                      onClick={(e) => { e.stopPropagation(); setConfirmingDelete(null); }}
                      type="button"
                    >
                      キャンセル
                    </button>
                    <button
                      className="project-list__confirm-delete"
                      onClick={(e) => handleDelete(e, project.projectId)}
                      type="button"
                    >
                      削除する
                    </button>
                  </div>
                </div>
              )}
            </div>
            );
          })}
        </div>

        {/*
          * Three ways to have nothing to show, and they need different words.
          * A filter that matches nothing is not an empty account, and an empty
          * archive is the state someone wants to be in.
          */}
        {!loading && shown.length === 0 && (
          <div className="project-list__empty">
            {filtering ? (
              <>
                <p className="project-list__empty-title">条件に合うプロジェクトがありません</p>
                <button
                  className="project-list__empty-action"
                  onClick={() => { setQuery(''); setFramework('all'); }}
                  type="button"
                >
                  条件をクリア
                </button>
              </>
            ) : showArchive ? (
              <p className="project-list__empty-title">アーカイブは空です</p>
            ) : tab === 'shared' ? (
              <p className="project-list__empty-title">
                共有しているプロジェクトはありません。プロジェクトを開いて「共有」から、ユーザーやグループを追加できます。
              </p>
            ) : (
              <p className="project-list__empty-title">
                まだプロジェクトがありません。上の「新規プロジェクト」から始められます。
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
