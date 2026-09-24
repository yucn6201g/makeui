import { useEffect, useRef, useState } from 'react';
import { usePublish } from '../hooks/usePublish';
import { useShares, type ShareCandidate } from '../hooks/useShares';
import type { ProjectRole } from '../hooks/useProjects';
import { shareDocument } from '../utils/shareDocument';
import { buildReactPreview } from '../utils/reactPreview';
import { ROLE_HINTS, ROLE_LABELS, SHARE_ROLES, canManageShares, canWrite, type ShareRole } from '../utils/shareRoles';
import { usePresence, usePresenceList } from '../hooks/usePresence';
import { useFlip, EXITING_ATTR } from '../hooks/useFlip';

/**
 * 共有: people and groups inside MakeUI, and a public link outside it.
 *
 * It was one click that published the preview and copied the link — the only
 * kind of sharing there was. Sharing with another MakeUI account is the second
 * kind, and it needs a panel: someone to find, a role to give, and a list of
 * who already has access to read and change. The link is still one click, from
 * the same panel.
 *
 * What the panel offers follows the viewer's role on the project: owners and
 * full members add people and change roles; editors see the members and can
 * publish; viewers see the members. Anyone who is a member can leave.
 */
export function ShareButton({
  html,
  title,
  projectId,
  role = 'owner',
}: {
  html: string | null;
  title?: string;
  /** Absent where there is no project to share with people — a bare preview. */
  projectId?: string;
  role?: ProjectRole;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Closed by a click outside or Escape, like the usage menu beside it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const panel = usePresence(open);

  return (
    <div className="app__share" ref={rootRef}>
      <button
        className={`app__header-btn${open ? ' app__header-btn--on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        title="ユーザー・グループと共有、または公開リンクを作成"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
          <polyline points="16 6 12 2 8 6" />
          <line x1="12" y1="2" x2="12" y2="15" />
        </svg>
        共有
      </button>
      {panel.mounted && (
        <div className="share-panel" role="dialog" aria-label="共有" data-state={panel.state}>
          {projectId && <PeopleSection projectId={projectId} role={role} />}
          <LinkSection html={html} title={title} allowed={canWrite(role)} />
        </div>
      )}
    </div>
  );
}

function PeopleSection({ projectId, role }: { projectId: string; role: ProjectRole }) {
  const s = useShares(projectId, true);
  const effectiveRole = s.role ?? role;
  const manage = canManageShares(effectiveRole);
  const [picked, setPicked] = useState<ShareCandidate | null>(null);
  const [newRole, setNewRole] = useState<ShareRole>('edit');
  /* Someone added slides in, someone removed folds away and the rest close up. */
  const membersRef = useRef<HTMLUListElement>(null);
  useFlip(membersRef);
  const members = usePresenceList(s.shares, (g) => `${g.type}:${g.id}`);

  const add = async () => {
    if (!picked) return;
    if (await s.grant(picked, newRole)) {
      setPicked(null);
      s.setQuery('');
    }
  };

  return (
    <section className="share-panel__section" aria-label="ユーザー・グループと共有">
      <h3 className="share-panel__heading">ユーザー・グループと共有</h3>

      {manage && (
        <div className="share-panel__add">
          {picked ? (
            <div className="share-panel__picked">
              <span className="share-panel__picked-name">
                {picked.type === 'group' && <GroupIcon />}
                {picked.label}
                <span className="share-panel__detail">{picked.detail}</span>
              </span>
              <button className="share-panel__icon-btn" onClick={() => setPicked(null)} type="button" aria-label="選択を取り消す">×</button>
            </div>
          ) : (
            <input
              className="share-panel__search"
              type="search"
              value={s.query}
              onChange={(e) => s.setQuery(e.target.value)}
              placeholder="ユーザー名・メールアドレス・グループ名で検索"
              aria-label="共有する相手を検索"
              autoFocus
            />
          )}
          {!picked && s.candidates.length > 0 && (
            <ul className="share-panel__results" role="listbox" aria-label="検索結果">
              {s.candidates.map((c) => {
                const already = s.shares.some((g) => g.type === c.type && g.id === c.id) || (c.type === 'user' && c.id === s.owner?.userId);
                return (
                  <li key={`${c.type}:${c.id}`}>
                    <button
                      className="share-panel__result"
                      onClick={() => setPicked(c)}
                      disabled={already}
                      type="button"
                      role="option"
                      aria-selected={false}
                    >
                      <span className="share-panel__result-name">
                        {c.type === 'group' && <GroupIcon />}
                        {c.label}
                      </span>
                      <span className="share-panel__detail">{already ? '共有済み' : c.detail}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {!picked && s.query.trim().length >= 2 && s.candidates.length === 0 && (
            <p className="share-panel__note">該当するユーザー・グループがありません</p>
          )}
          {picked && (
            <div className="share-panel__add-row">
              <RoleSelect value={newRole} onChange={setNewRole} label="付与する権限" />
              <button className="app__header-btn app__header-btn--primary" onClick={() => { void add(); }} disabled={s.busy} type="button">
                追加
              </button>
            </div>
          )}
          {picked && <p className="share-panel__note">{ROLE_HINTS[newRole]}</p>}
        </div>
      )}

      <ul className="share-panel__members" aria-label="アクセスできるユーザー" ref={membersRef}>
        {s.owner && (
          <li className="share-panel__member">
            <span className="share-panel__member-name">
              {s.owner.name}
              {s.owner.userId === s.self && <span className="share-panel__detail">（あなた）</span>}
            </span>
            <span className="share-panel__role-badge">{ROLE_LABELS.owner}</span>
          </li>
        )}
        {members.map(({ item: g, exiting }) => {
          const isSelf = g.type === 'user' && g.id === s.self;
          return (
            <li key={`${g.type}:${g.id}`} className="share-panel__member" {...(exiting ? { [EXITING_ATTR]: '', 'aria-hidden': true } : {})}>
              <span className="share-panel__member-name" title={g.grantedByName ? `${g.grantedByName} さんが共有` : undefined}>
                {g.type === 'group' && <GroupIcon />}
                {g.label}
                {isSelf ? <span className="share-panel__detail">（あなた）</span> : g.email && <span className="share-panel__detail">{g.email}</span>}
              </span>
              {manage ? (
                <span className="share-panel__member-actions">
                  <RoleSelect value={g.role} onChange={(r) => { void s.grant(g, r); }} label={`${g.label} の権限`} disabled={s.busy} />
                  <button className="share-panel__icon-btn" onClick={() => { void s.revoke(g); }} disabled={s.busy} type="button" aria-label={`${g.label} との共有を解除`} title="共有を解除">×</button>
                </span>
              ) : (
                <span className="share-panel__member-actions">
                  <span className="share-panel__role-badge">{ROLE_LABELS[g.role]}</span>
                  {isSelf && (
                    <button className="share-panel__text-btn" onClick={() => { void s.revoke(g); }} disabled={s.busy} type="button">
                      共有から外れる
                    </button>
                  )}
                </span>
              )}
            </li>
          );
        })}
        {!s.loading && s.shares.length === 0 && (
          <li className="share-panel__note">まだ誰とも共有していません</li>
        )}
      </ul>
      {s.error && <p className="share-panel__error" role="alert">{s.error}</p>}
      {!manage && effectiveRole !== 'owner' && (
        <p className="share-panel__note">共有ユーザーの追加は、所有者と全権限のユーザーだけができます</p>
      )}
    </section>
  );
}

function RoleSelect({ value, onChange, label, disabled }: { value: ShareRole; onChange: (r: ShareRole) => void; label: string; disabled?: boolean }) {
  return (
    <select
      className="share-panel__role"
      value={value}
      onChange={(e) => onChange(e.target.value as ShareRole)}
      aria-label={label}
      disabled={disabled}
    >
      {SHARE_ROLES.map((r) => (
        <option key={r} value={r} title={ROLE_HINTS[r]}>{ROLE_LABELS[r]}</option>
      ))}
    </select>
  );
}

function GroupIcon() {
  return (
    <svg className="share-panel__group-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-label="グループ">
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 20a6.5 6.5 0 0 0-3-5.5" />
    </svg>
  );
}

/**
 * The public link: build, publish, copy — the one-click share this used to be.
 *
 * The copy is attempted after two awaits, so it can land outside the click's
 * transient activation and be refused. That is why the URL is kept: a refused
 * copy falls back to showing it rather than losing a link that was published
 * either way, and publishing again would spend another upload for the same
 * document.
 */
function LinkSection({ html, title, allowed }: { html: string | null; title?: string; allowed: boolean }) {
  const { isPublishing, error, publish } = usePublish();
  const [phase, setPhase] = useState<'idle' | 'working' | 'copied' | 'failed'>('idle');
  /** Set only when the clipboard refused, so the link can still be taken by hand. */
  const [manualUrl, setManualUrl] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /* Selected on arrival: the fallback exists to be copied by hand, and the hand
     part should be one keystroke rather than a drag across a long URL. */
  useEffect(() => {
    if (manualUrl) inputRef.current?.select();
  }, [manualUrl]);

  const handleClick = async () => {
    if (!html || phase === 'working') return;
    setPhase('working');
    setManualUrl(null);
    setProblem(null);

    // Diagnostics off: the overlay is a development aid, and a red panel of
    // Japanese stack trace over a link someone has already sent is not one.
    const doc = await shareDocument(html, (files) => buildReactPreview(files, { diagnostics: false }), title);
    if (doc.error || !doc.html) {
      setProblem(doc.error ?? '公開用ドキュメントを生成できませんでした。');
      setPhase('failed');
      return;
    }

    const url = await publish(doc.html);
    if (!url) {
      // The hook's own message, which distinguishes an expired session from a
      // network failure. `error` has been set by the time this renders.
      setPhase('failed');
      return;
    }

    try {
      await navigator.clipboard.writeText(url);
      setPhase('copied');
    } catch {
      setManualUrl(url);
      setPhase('idle');
    }
  };

  const label =
    phase === 'working' || isPublishing ? '生成中…'
      : phase === 'copied' ? 'リンクをコピーしました'
      : phase === 'failed' ? '失敗しました'
      : '公開リンクを作成してコピー';

  return (
    <section className="share-panel__section" aria-label="リンクで公開">
      <h3 className="share-panel__heading">リンクで公開</h3>
      <p className="share-panel__note">MakeUI のアカウントがない人にも見せられる公開ページを作ります（30日間有効）。</p>
      <button
        className="app__header-btn"
        onClick={() => { void handleClick(); }}
        disabled={!html || !allowed || phase === 'working'}
        type="button"
        title={!allowed ? '閲覧権限では公開リンクを作成できません' : !html ? 'まだ画面がありません' : undefined}
      >
        {label}
      </button>
      {(problem || (phase === 'failed' && error)) && <p className="share-panel__error" role="alert">{problem ?? error}</p>}
      {manualUrl && (
        <div className="share-panel__manual">
          <p className="share-panel__note">クリップボードに書き込めませんでした。以下をコピーしてください。</p>
          <input ref={inputRef} className="share-panel__search" type="text" value={manualUrl} readOnly aria-label="公開URL" />
        </div>
      )}
    </section>
  );
}
