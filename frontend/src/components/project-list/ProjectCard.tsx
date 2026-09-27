/**
 * One card of the project list: its thumbnail, name, format, dates, sharing,
 * and the star, archive and delete controls.
 *
 * Memoised, and given only its own state and one stable object of actions, so a
 * change elsewhere in the list — the tab row answering a click, another card's
 * star, a keystroke in the search — does not redraw it. With hundreds of cards
 * that redraw was most of what a tab change cost (2026-09-27).
 */
import { memo, type MouseEvent } from 'react';
import type { Project } from '../../hooks/useProjects';
import { ProjectThumbnail } from './ProjectThumbnail';
import { projectKind } from '../../utils/projects/projectFilter';
import { ROLE_LABELS } from '../../utils/projects/shareRoles';
import { EXITING_ATTR } from '../../hooks/useFlip';

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

/** Compact token counts: a project can run to hundreds of thousands. */
const formatTokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}k`;
  return String(n);
};

const formatDate = (iso: string): string => {
  const d = new Date(iso);
  return d.toLocaleDateString('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

/** What a card can ask of the list. One object, stable for the list's lifetime. */
export interface CardActions {
  activate: (project: Project) => void;
  archive: (e: MouseEvent, projectId: string, archived: boolean) => void;
  favourite: (e: MouseEvent, projectId: string, favourite: boolean) => void;
  askDelete: (projectId: string) => void;
  cancelDelete: () => void;
  delete: (e: MouseEvent, projectId: string) => void;
}

interface ProjectCardProps {
  project: Project;
  /** Leaving the grid: kept for its exit, out of the tab order. */
  exiting: boolean;
  selecting: boolean;
  isSelected: boolean;
  /** A run for it is in progress in this browser. */
  running: boolean;
  /** Its delete confirmation is open. */
  confirming: boolean;
  actions: CardActions;
  fetchHtml: (projectId: string) => Promise<string | null>;
}

export const ProjectCard = memo(function ProjectCard({
  project, exiting, selecting, isSelected, running, confirming, actions, fetchHtml,
}: ProjectCardProps) {
  const kind = projectKind(project);
  const archived = Boolean(project.archivedAt);
  const favourite = Boolean(project.favouritedAt);
  /*
   * What this account may do to it. A viewer gets neither the star nor
   * the archive — both write the project, which is the owner's and the
   * other members' as much as theirs.
   */
  const role = project.access?.role ?? 'owner';
  const canWrite = role !== 'view';
  return (
  <div
                  className={`project-list__card${archived ? ' project-list__card--archived' : ''}${running ? ' project-list__card--running' : ''}${isSelected ? ' project-list__card--selected' : ''}`}
    aria-hidden={exiting || undefined}
    {...(exiting ? { [EXITING_ATTR]: '' } : {})}
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
        fetchHtml={fetchHtml}
      />
    </div>
    <div className="project-list__card-info">
      <div className="project-list__card-line">
        {/*
          The card's own control. It used to be the whole card as a
          role="button" div, which put the star and the archive button
          inside another button — two controls a screen reader cannot
          tell apart (axe: nested-interactive, 2026-09-27). The name is
          the button now, and its ::after covers the card, so a click
          anywhere on it still opens the project.
        */}
        <button
          type="button"
          className="project-list__card-name project-list__card-open"
          onClick={() => actions.activate(project)}
          role={selecting ? 'checkbox' : undefined}
          aria-checked={selecting ? isSelected : undefined}
          tabIndex={exiting ? -1 : 0}
        >
          {project.name}
        </button>
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
        onClick={(e) => actions.favourite(e, project.projectId, !favourite)}
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
        onClick={(e) => actions.archive(e, project.projectId, true)}
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
          onClick={(e) => actions.archive(e, project.projectId, false)}
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
          onClick={(e) => { e.stopPropagation(); actions.askDelete(project.projectId); }}
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
            onClick={(e) => { e.stopPropagation(); actions.cancelDelete(); }}
            type="button"
          >
            キャンセル
          </button>
          <button
            className="project-list__confirm-delete"
            onClick={(e) => actions.delete(e, project.projectId)}
            type="button"
          >
            削除する
          </button>
        </div>
      </div>
    )}
  </div>
  );
});
