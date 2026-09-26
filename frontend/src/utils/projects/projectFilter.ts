import type { Project } from '../../hooks/useProjects';
import { detectKind, type OutputKind } from '../preview/frameworkKind';
import { splitHtmlToFiles } from '../preview/virtualFs';

/**
 * Deciding which projects the list shows — search, framework, archive.
 *
 * Kept out of the component so each rule can be tested against a project rather
 * than against a rendered grid, and so `projectKind` has one definition. The
 * badge on a card and the framework filter have to agree about what a project
 * is; if they were computed in two places they eventually would not, which is
 * the same failure the card badge already had once against the preview.
 */

export type FrameworkFilter = 'all' | OutputKind;

/**
 * The framework a project is, as the card badge reports it.
 *
 * A stored `html` is not trusted over the document: every run was recorded as
 * `html` for as long as the server classified with a detector that could no
 * longer match anything, so the stored value is present, wrong, and — being
 * truthy — would take priority over the fallback that gets it right. `react`,
 * `vue` is taken as written; it is only ever recorded from
 * the files in the first place.
 */
export function projectKind(project: Project): string | null {
  const stored = project.outputKind && project.outputKind !== 'html' ? project.outputKind : null;
  return (
    stored ??
    (project.lastHtml ? detectKind(splitHtmlToFiles(project.lastHtml)) : null) ??
    project.outputKind ??
    null
  );
}

/**
 * Search text reduced to what a comparison should care about.
 *
 * Case is folded, and full-width ASCII is brought down to half — with an IME
 * active, typing `Ｒｅａｃｔ` is as likely as typing `React`, and the two look
 * alike enough that a user would not know why the search found nothing. Kana
 * and kanji are left exactly as they are: unlike the credential fields, a
 * project name is mostly Japanese, and stripping it would leave nothing to
 * match on.
 */
export function normalizeSearch(value: string): string {
  return value
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ')
    .trim()
    .toLowerCase();
}

/** Whether a project name contains the query. An empty query matches everything. */
export function matchesQuery(name: string, query: string): boolean {
  const q = normalizeSearch(query);
  if (!q) return true;
  return normalizeSearch(name).includes(q);
}

/** What the list is ordered by. `recent` is the order the server returns. */
export type SortKey = 'recent' | 'tokens' | 'requests';
export type SortDirection = 'asc' | 'desc';

interface ListSort {
  key: SortKey;
  direction: SortDirection;
}

/**
 * Which tab a project sits on.
 *
 * The archive wins: an archived project is put away, whoever it is shared with.
 * Otherwise a project with any share — one the account shared, or one shared
 * with it — is on 共有, for both sides, and everything else on プロジェクト.
 */
export type ProjectTab = 'active' | 'shared' | 'archive';

export function tabOf(p: Project): ProjectTab {
  if (p.archivedAt) return 'archive';
  if (p.sharedAt || (p.access && p.access.role !== 'owner')) return 'shared';
  return 'active';
}

interface ListFilter {
  query: string;
  framework: FrameworkFilter;
  /** The tab. Takes precedence over `archived`. */
  tab?: ProjectTab;
  /** Show the archive instead of the active list — the two-tab form of `tab`. */
  archived?: boolean;
  /**
   * Show only starred projects.
   *
   * A separate axis from `framework`, not a fourth value of it. "React" and
   * "favourite" answer different questions — one is what a project is made of,
   * the other is what the user thinks of it — and folding them into one control
   * would mean you could never ask for a starred Vue project.
   */
  favourite?: boolean;
  /** Absent leaves the server's order — most recently updated first. */
  sort?: ListSort;
}

/**
 * The projects a given view should show.
 *
 * Archive first, because it is the only rule that changes which set is being
 * looked at rather than narrowing one: a project in the archive is out of the
 * way, and a search from the main list must not turn it up.
 */
const tabFor = (filter: Pick<ListFilter, 'tab' | 'archived'>): ProjectTab =>
  filter.tab ?? (filter.archived ? 'archive' : 'active');

export function visibleProjects(projects: Project[], filter: ListFilter): Project[] {
  const tab = tabFor(filter);
  const kept = projects.filter((p) => {
    if (tabOf(p) !== tab) return false;
    if (filter.favourite && !p.favouritedAt) return false;
    if (filter.framework !== 'all' && projectKind(p) !== filter.framework) return false;
    return matchesQuery(p.name, filter.query);
  });
  return sortProjects(kept, filter.sort);
}

/**
 * Order, with favourites kept on top.
 *
 * A star is a statement about where a project should be, not about how much it
 * cost — sorting by tokens and losing the starred one to the bottom of the page
 * defeats the point of having starred it. So the star is the first key and the
 * chosen one is the second, in both directions. The archive has no favourites
 * to lift, so nothing changes there.
 *
 * Sorting is stable within a group: `Array.prototype.sort` is specified stable,
 * so equal values stay in the order the server returned them, which is most
 * recently updated first. That is what makes `tokens` on a list of untouched
 * projects still read as a sensible list rather than a shuffled one.
 */
export function sortProjects(projects: Project[], sort?: ListSort): Project[] {
  const starred = (p: Project) => (p.favouritedAt ? 0 : 1);
  const out = [...projects];
  if (!sort) {
    // No sort asked for: the server's order, with the stars lifted.
    return out.sort((a, b) => starred(a) - starred(b));
  }
  const sign = sort.direction === 'asc' ? 1 : -1;

  /*
   * `recent` now sorts rather than deferring to the server.
   *
   * It used to return the server's order untouched, which is descending by
   * `updatedAt` and correct — but it meant the one direction the list could not
   * be reversed was its own default. Comparing the timestamps explicitly gives
   * both directions and produces byte-identical output to the old code in the
   * descending case, which is what makes this safe to change.
   */
  if (sort.key === 'recent') {
    return out.sort(
      (a, b) => starred(a) - starred(b) || (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0) * sign
    );
  }
  const value = (p: Project) =>
    sort.key === 'tokens' ? p.totalTokens ?? 0 : p.requestCount ?? 0;
  return out.sort((a, b) => starred(a) - starred(b) || (value(a) - value(b)) * sign);
}

/** How many projects each framework filter would show, for the counts on the tabs. */
export function frameworkCounts(projects: Project[], tabOrArchived: ProjectTab | boolean): Record<FrameworkFilter, number> {
  const tab = typeof tabOrArchived === 'boolean' ? tabFor({ archived: tabOrArchived }) : tabOrArchived;
  const counts: Record<FrameworkFilter, number> = { all: 0, react: 0, vue: 0 };
  for (const p of projects) {
    if (tabOf(p) !== tab) continue;
    counts.all++;
    const kind = projectKind(p);
    if (kind === 'react' || kind === 'vue') counts[kind]++;
  }
  return counts;
}
