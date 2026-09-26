import { useState, useEffect, useMemo, useRef } from 'react';
import { type UserUsageSummary, type AdminProject, type AdminVersion } from '../../hooks/useAdmin';
import { Preview } from '../workspace/Preview';
import { isOlderScoreScale } from '../../utils/projects/scoreScale';
import { versionQualityLabel, versionQualityTitle } from '../../utils/projects/versionQuality';
import { formatNumber, formatDate } from './shared';

/**
 * What a user actually made.
 *
 * The usage tab answers how much someone spent; this answers on what. Three
 * levels, because that is how the data is shaped and because each level is a
 * separate request: a user's projects, a project's versions, and one version's
 * document.
 *
 * The prompt is the column that matters and is given the room. A project name is
 * usually something typed once and never revisited; the prompt is the thing that
 * explains why a run cost what it cost, and it is the only field here that a
 * person wrote.
 */
export function ProjectsTab({
  users,
  openOn,
  fetchProjects,
  fetchProjectVersions,
  fetchVersion,
}: {
  users: UserUsageSummary[];
  /**
   * An account to open on, from somewhere else in the panel.
   *
   * Carries a token as well as an id so that asking twice for the SAME person
   * still reopens them: a plain id would be equal to the one already showing
   * and the effect would not fire, which reads as the button doing nothing.
   */
  openOn: { userId: string; token: number } | null;
  fetchProjects: (userId: string) => Promise<AdminProject[]>;
  fetchProjectVersions: (userId: string, projectId: string) => Promise<AdminVersion[]>;
  fetchVersion: (userId: string, versionId: string) => Promise<AdminVersion>;
}) {
  const [userId, setUserId] = useState<string>('');
  /** Which prompts have been opened out of their three-line clamp. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [userSearch, setUserSearch] = useState('');
  const [projectSearch, setProjectSearch] = useState('');
  const [projects, setProjects] = useState<AdminProject[]>([]);
  const [projectId, setProjectId] = useState<string>('');
  const [versions, setVersions] = useState<AdminVersion[]>([]);
  const [viewing, setViewing] = useState<AdminVersion | null>(null);
  const [busy, setBusy] = useState<'projects' | 'versions' | 'document' | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async (what: 'projects' | 'versions' | 'document', f: () => Promise<void>) => {
    setBusy(what);
    setErr(null);
    try {
      await f();
    } catch (e) {
      setErr((e as Error).message || '読み込みに失敗しました');
    } finally {
      setBusy(null);
    }
  };

  const openUser = (id: string) => {
    setUserId(id);
    setProjectId('');
    setVersions([]);
    setProjects([]);
    setViewing(null);
    if (id) run('projects', async () => setProjects(await fetchProjects(id)));
  };

  const openProject = (id: string) => {
    setProjectId(id);
    setVersions([]);
    setViewing(null);
    if (id) run('versions', async () => setVersions(await fetchProjectVersions(userId, id)));
  };

  const openVersion = (versionId: string) =>
    run('document', async () => setViewing(await fetchVersion(userId, versionId)));

  const togglePrompt = (versionId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(versionId)) next.delete(versionId);
      else next.add(versionId);
      return next;
    });
  };

  /*
   * Opened from another tab. `openOnRef` holds the token that has been acted
   * on, so a re-render for any other reason does not refetch — and the effect
   * depends on the token rather than the id, so the same person can be asked
   * for twice.
   */
  const openOnRef = useRef<number>(0);
  useEffect(() => {
    if (!openOn || openOn.token === openOnRef.current) return;
    openOnRef.current = openOn.token;
    setUserSearch('');
    setExpanded(new Set());
    openUser(openOn.userId);
    // `openUser` is redefined every render and starts a fetch; depending on it
    // would restart that fetch on every render, which is the shape of the
    // runaway-save loop this project has already had once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openOn]);

  const chosen = users.find((u) => u.userId === userId) ?? null;
  const matches = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) =>
      u.displayName.toLowerCase().includes(q)
      || u.email.toLowerCase().includes(q)
      || u.userId.toLowerCase().includes(q));
  }, [users, userSearch]);

  const project = projects.find((p) => p.projectId === projectId);
  /*
   * The project list narrows too, on the same rule as the user picker above it.
   *
   * One account has thirteen projects and the names are mostly 「Untitled」, so
   * what identifies a row is as often the framework or the design system as the
   * name — all three are on the row, so all three are searched. The chosen
   * project stays in the list whether or not it still matches: it is what the
   * right-hand pane is showing, and a row disappearing from under the history it
   * belongs to reads as the history belonging to nothing.
   */
  const shownProjects = useMemo(() => {
    const q = projectSearch.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) =>
      p.projectId === projectId
      || p.name.toLowerCase().includes(q)
      || (p.outputKind ?? '').toLowerCase().includes(q)
      || (p.preset ?? '').toLowerCase().includes(q));
  }, [projects, projectSearch, projectId]);
  /*
   * Summed from the projects rather than taken from the usage row. They answer
   * different questions — the usage row is this month across everything,
   * including runs whose project has since been deleted — and putting one under
   * the other with the same label would invite them to be compared.
   */
  const counted = projects.filter((p) => p.totalTokens !== undefined);

  return (
    <div className="adm-tabpane">
      <div className="adm-toolbar">
        {/*
          * A search box, not a dropdown.
          *
          * A <select> is fine for five accounts and wrong for fifty: it has to be
          * opened before it can be read, it cannot be typed into, and the name a
          * person is looking for is the one thing they already know. The list
          * below narrows as they type and the current pick stays visible whether
          * or not it still matches.
          */}
        <input
          className="adm-input adm-input--search"
          type="search"
          value={userSearch}
          onChange={(e) => setUserSearch(e.target.value)}
          placeholder="ユーザー名/メールアドレスで検索"
          aria-label="ユーザー名/メールアドレスで検索"
        />
        {chosen ? (
          <>
            <span className="adm-toolbar__chosen">
              {chosen.displayName || chosen.email}
              {chosen.group && <span className="adm-uid">{chosen.group}</span>}
            </span>
            <button
              className="adm-btn adm-btn--ghost adm-btn--sm"
              type="button"
              onClick={() => openUser('')}
            >
              選択を解除
            </button>
            <span className="adm-toolbar__note">
              {projects.length}プロジェクト
              {counted.length > 0 && ` ・ 合計 ${formatNumber(counted.reduce((n, p) => n + (p.totalTokens ?? 0), 0))} トークン`}
              {counted.length < projects.length && `（${projects.length - counted.length}件は計測前）`}
            </span>
          </>
        ) : (
          <span className="adm-toolbar__note">
            {matches.length} / {users.length} 件
          </span>
        )}
      </div>

      {!chosen && (
        <div className="adm-userpicks">
          {matches.map((u) => (
            <button
              key={u.userId}
              type="button"
              className="adm-userpick"
              onClick={() => openUser(u.userId)}
            >
              <span className="adm-userpick__line">
                <span className="adm-email">{u.displayName || u.email || u.userId}</span>
                {/*
                  How much there is to read, before the click rather than after.
                  This picker is a list of names with nothing to choose between
                  them, and the account with thirteen projects and the one with
                  none looked identical — so finding somebody's work meant
                  opening people one at a time.
                */}
                {typeof u.projectCount === 'number' && (
                  <span className="adm-userpick__count">{u.projectCount} 件</span>
                )}
              </span>
              {/* The address stays as the second line: names are not unique, and
                  this picker decides whose work is about to be read. The group
                  is on the same line because "which tenant" is the other half of
                  that question. */}
              <span className="adm-uid">{u.email}{u.group ? ` ・ ${u.group}` : ''}</span>
            </button>
          ))}
          {matches.length === 0 && (
            <div className="adm-empty">
              {userSearch ? '該当するユーザーがいません' : 'ユーザーがいません'}
            </div>
          )}
        </div>
      )}

      {err && <div className="adm-error-banner" role="alert">{err}</div>}

      {!userId ? null : busy === 'projects' ? (
        <div className="adm-loading"><span>読み込み中…</span></div>
      ) : (
        <div className="adm-split">
          <div className="adm-split__col">
            <div className="adm-split__head">
              プロジェクト
              {/*
                Always, not only while searching. 「何件あるか」 is the first
                thing asked of a list, and it was answered only once somebody
                had typed into the box — so an unfiltered list of thirteen
                showed no number at all.
              */}
              {userId && (
                <span className="adm-split__note">
                  {projectSearch
                    ? `${shownProjects.length} / ${projects.length} 件`
                    : `${projects.length} 件`}
                </span>
              )}
            </div>
            <div className="adm-subbar">
              <input
                className="adm-input adm-input--sm"
                type="search"
                value={projectSearch}
                onChange={(e) => setProjectSearch(e.target.value)}
                placeholder="プロジェクト名/フレームワークで検索"
                aria-label="プロジェクト名/フレームワークで検索"
              />
            </div>
            <div className="adm-table-wrap">
              <table className="adm-table">
                <thead>
                  <tr>
                    <th className="adm-th">プロジェクト</th>
                    <th className="adm-th adm-th--num adm-th--tok">トークン数</th>
                    <th className="adm-th adm-th--num adm-th--run">リクエスト数</th>
                    <th className="adm-th adm-th--date">更新日時</th>
                  </tr>
                </thead>
                <tbody>
                  {shownProjects.map((p) => (
                    <tr
                      key={p.projectId}
                      className={`adm-tr adm-tr--click${p.projectId === projectId ? ' adm-tr--active' : ''}`}
                      onClick={() => openProject(p.projectId)}
                    >
                      <td className="adm-td">
                        <span className="adm-email">{p.name}</span>
                        <span className="adm-uid">
                          {p.outputKind ?? '-'}
                          {p.preset && p.preset !== 'none' ? ` ・ ${p.preset}` : ''}
                          {p.archivedAt ? ' ・ アーカイブ済' : ''}
                        </span>
                      </td>
                      {/* Absent is not zero: these projects predate the counter. */}
                      <td className="adm-td adm-td--num">{p.totalTokens === undefined ? '—' : formatNumber(p.totalTokens)}</td>
                      <td className="adm-td adm-td--num">{p.requestCount ?? '—'}</td>
                      <td className="adm-td adm-td--muted">{formatDate(p.updatedAt)}</td>
                    </tr>
                  ))}
                  {shownProjects.length === 0 && (
                    <tr>
                      <td colSpan={4} className="adm-td adm-td--empty">
                        {projectSearch ? '該当するプロジェクトがありません' : 'プロジェクトがありません'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="adm-split__col">
            <div className="adm-split__head">
              {project ? `${project.name} の履歴` : '履歴'}
              {/*
                The project row's total is the sum over every RUN, including the
                ones whose document was rejected; these are the runs that
                produced a version. They do not add up to it and should not be
                read as if they do.
              */}
              {project && (
                <span className="adm-split__note">
                  {versions.length > 0 ? `${versions.length} 件 ・ ` : ''}実行ごとの消費
                </span>
              )}
            </div>
            {!projectId ? (
              <div className="adm-empty">プロジェクトを選ぶと、投入されたプロンプトと生成結果が表示されます</div>
            ) : busy === 'versions' ? (
              <div className="adm-loading"><span>読み込み中…</span></div>
            ) : (
              <div className="adm-table-wrap">
                <table className="adm-table">
                  <thead>
                    <tr>
                      <th className="adm-th">プロンプト</th>
                      <th className="adm-th adm-th--num adm-th--tok">トークン数</th>
                      <th className="adm-th adm-th--num adm-th--run">スコア</th>
                      <th className="adm-th adm-th--num adm-th--quality">要件・指摘</th>
                      <th className="adm-th adm-th--model">モデル</th>
                      <th className="adm-th adm-th--date">実行日時</th>
                      <th className="adm-th adm-th--act"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {versions.map((v) => (
                      <tr key={v.versionId} className="adm-tr">
                        <td className="adm-td">
                          {/*
                            * The clamp lives on a div inside the cell, not on the
                            * cell. `display: -webkit-box` on a <td> replaces the
                            * table-cell display and the clamp stops holding — it
                            * drew the ellipsis at line three and then a fourth
                            * line under it.
                            *
                            * And it opens. A prompt is the one field on this row
                            * somebody reads rather than scans, and three lines of
                            * it plus a `title` tooltip is not reading — a tooltip
                            * cannot be scrolled, cannot be selected, and goes
                            * away when the pointer moves. A button rather than a
                            * div with a handler, so it is reachable by keyboard
                            * and announces its state.
                            */}
                          <button
                            type="button"
                            className={`adm-prompt${expanded.has(v.versionId) ? ' adm-prompt--open' : ''}`}
                            onClick={() => togglePrompt(v.versionId)}
                            aria-expanded={expanded.has(v.versionId)}
                            title={expanded.has(v.versionId) ? 'クリックで折りたたむ' : 'クリックで全文を表示'}
                          >
                            {v.prompt || '（プロンプトなし）'}
                          </button>
                        </td>
                        {/* Absent is not zero — see AdminVersion.tokens. */}
                        <td
                          className="adm-td adm-td--num"
                          title={v.tokens ? `入力 ${v.tokens.input.toLocaleString()} / 出力 ${v.tokens.output.toLocaleString()}` : '記録前のバージョンです'}
                        >
                          {v.tokens ? formatNumber(v.tokens.input + v.tokens.output) : '—'}
                        </td>
                        <td className="adm-td adm-td--num">
                          {v.score}
                          {/*
                            * An edit is scored without a browser, so up to 173
                            * points of runtime deduction are unreachable on it.
                            * Saying which is which is the difference between a
                            * comparable number and a misleading one.
                            */}
                          {v.scoreVerified === false && <span className="adm-uid">静的のみ</span>}
                          {isOlderScoreScale(v) && (
                            <span className="adm-uid" title="計測方法の変更（2026-09-13）より前のスコアです。変更後のスコアとは直接比べられません。">
                              旧基準
                            </span>
                          )}
                        </td>
                        {/*
                          * What the score cannot say: whether the version does
                          * what was asked, and what it shipped still wrong. Both
                          * were only in the chat reply. A dash is "not recorded",
                          * never zero.
                          */}
                        <td
                          className="adm-td adm-td--num"
                          title={versionQualityTitle(v)}
                        >
                          {versionQualityLabel(v)}
                        </td>
                        <td className="adm-td adm-td--muted">{v.model || '-'}</td>
                        <td className="adm-td adm-td--muted">{formatDate(v.createdAt)}</td>
                        <td className="adm-td adm-td--action">
                          <button
                            className="adm-btn adm-btn--secondary adm-btn--sm"
                            type="button"
                            onClick={() => openVersion(v.versionId)}
                            disabled={busy === 'document'}
                          >
                            表示
                          </button>
                        </td>
                      </tr>
                    ))}
                    {versions.length === 0 && (
                      <tr><td colSpan={6} className="adm-td adm-td--empty">履歴がありません</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {viewing && <ViewerOverlay version={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

/**
 * The generated UI itself, with the prompt that asked for it above it.
 *
 * Renders through `Preview`, the same component the workspace uses, rather than
 * writing the stored document into an iframe directly. Writing it directly is
 * what shipped, and it showed the source: a stored project is not an HTML page,
 * it is the fenced multi-file transport — `@@@makeui:file src/App.tsx` and the
 * rest — which a browser renders as the text it is. Only React output is ever a
 * runnable document without a build, and none of the three frameworks is stored
 * that way.
 *
 * Reusing the component rather than repeating its three steps
 * (`splitHtmlToFiles` → `toProjectFiles` → `buildReactPreview`) is the point: an
 * admin looking at somebody's work should see what that person saw, and a second
 * compile path would eventually disagree about which projects render. It brings
 * its own `sandbox="allow-scripts"` with it — these are React, Vue and Svelte
 * projects built from user prompts, so they need scripts to render at all, but
 * not same-origin, which would put another user's generated code on this origin
 * with an admin session in it.
 */
function ViewerOverlay({ version, onClose }: { version: AdminVersion; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="adm-viewer" role="dialog" aria-label="生成されたUI">
      <div className="adm-viewer__bar">
        <div className="adm-viewer__meta">
          <span className="adm-viewer__prompt" title={version.prompt}>{version.prompt || '（プロンプトなし）'}</span>
          <span className="adm-uid">
            {formatDate(version.createdAt)} ・ {version.model || '-'} ・ スコア {version.score}
          </span>
        </div>
        <button className="adm-btn adm-btn--ghost adm-btn--icon" onClick={onClose} aria-label="閉じる" type="button">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </button>
      </div>
      {version.html ? (
        <div className="adm-viewer__frame">
          <Preview html={version.html} score={version.score} />
        </div>
      ) : (
        <div className="adm-empty">このバージョンのドキュメントは残っていません</div>
      )}
    </div>
  );
}

