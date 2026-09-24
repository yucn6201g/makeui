import type { ProjectRole } from '../hooks/useProjects';

/**
 * The three roles a project is shared at, as the screens name them.
 *
 *   full  全権限 — the owner's equivalent, including adding people
 *   edit  編集   — everything except adding people
 *   view  閲覧   — reading only
 */
export type ShareRole = Exclude<ProjectRole, 'owner'>;

export const ROLE_LABELS: Record<ProjectRole, string> = {
  owner: '所有者',
  full: '全権限',
  edit: '編集',
  view: '閲覧',
};

export const ROLE_HINTS: Record<ShareRole, string> = {
  full: '所有者と同じ操作ができます（共有ユーザーの追加も含む）',
  edit: '共有ユーザーの追加以外のすべての操作ができます',
  view: 'プロジェクトの閲覧だけができます',
};

export const SHARE_ROLES: readonly ShareRole[] = ['full', 'edit', 'view'];

/** Whether a role may change the project — prompts, edits, renaming, archiving. */
export const canWrite = (role: ProjectRole | undefined): boolean => role !== 'view';
/** Whether a role may add people, change their roles and remove them. */
export const canManageShares = (role: ProjectRole | undefined): boolean => role === undefined || role === 'owner' || role === 'full';
