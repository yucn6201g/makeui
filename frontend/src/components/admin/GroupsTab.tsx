import { useState, useMemo } from 'react';
import { type UserUsageSummary, type CognitoUser, type ModelId, type UserGroup } from '../../hooks/useAdmin';
import { Dropdown } from '../common/Dropdown';
import { UNLIMITED, ALL_MODELS, asMoney, usd } from './shared';
import { BudgetEditor, ModelPicker } from './editors';

/**
 * User groups, and who administers each.
 *
 * Super-admin only, and the tab is not drawn for anyone else — a group
 * administrator who could create groups or move accounts between them could
 * appoint themselves over another one, which is the whole boundary this
 * introduces. The server refuses it too; this is the convenience.
 *
 * ## Shaped around the group, not around the row
 *
 * The first version put a `<select>` in every row of both tables: one to choose
 * a user's group, one to choose a group's administrator. It worked and it was
 * unpleasant. Three things were wrong with it and they compound.
 *
 * The two panes were unrelated, so moving three people into a group meant
 * finding each of them in a list of everybody and setting the same value three
 * times. Appointing an administrator needed the person to be in the group
 * ALREADY, because the menu was built from the group's members — so the natural
 * order, "make Taro the admin of Acme", was two operations in two tables with a
 * refetch between them. And neither list could be searched, which is fine for
 * five accounts and the reason a directory control has a search box.
 *
 * So the group is selected on the left and the right pane acts on it. Every
 * account is listed once, with the action that makes sense for it: in this
 * group, in another one, or in none. Appointing is a button on the member's own
 * row, and the server adds the membership if it is missing, so the order stops
 * mattering.
 *
 * The one pulldown left is the one a pulldown is right for — picking the
 * administrator out of the members — and it is the composer's `Dropdown` rather
 * than a native `<select>`, so every menu in the product looks the same.
 */
export function GroupsTab({
  groups,
  users,
  onCreate,
  onDelete,
  onSetMembership,
  onSetAdmin,
  onSetLimit,
  onSetUserLimit,
  canSetGroupLimit,
  usage,
  onSetModels,
  onOpenProjects,
  onRefresh,
}: {
  groups: UserGroup[];
  users: CognitoUser[];
  onCreate: (name: string, description?: string) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
  onSetMembership: (username: string, group: string | null) => Promise<void>;
  onSetAdmin: (group: string, username: string | null) => Promise<void>;
  onSetLimit: (group: string, limit: number) => Promise<void>;
  /**
   * One member's own budget, set from the list they are being managed in.
   *
   * The same route the user tab uses, over the same account. Splitting a group's
   * budget among its people is the reason the group's total exists, and doing it
   * meant leaving this screen, opening the user tab and finding the same person
   * again — from a list that already has them in front of you. This tab is
   * super-admin only, so there is nothing further to gate.
   */
  onSetUserLimit: (userId: string, limit: number) => Promise<void>;
  /**
   * The usage rows, joined to the member list by email.
   *
   * A `CognitoUser` is the directory's answer and carries no allowance; which
   * models an account may pick is stored beside its budget, on the usage row.
   * The two are joined here for the same reason the user tab joins them — the
   * member list is where a group administrator is already standing.
   */
  usage: UserUsageSummary[];
  onSetModels: (userId: string, models: ModelId[]) => Promise<void>;
  /** Opens the projects tab on one account. Nothing else can reach it. */
  onOpenProjects: (userId: string) => void;
  /**
   * False for a group administrator. They divide their group's budget among
   * their people on the usage tab; the total is what the account is billed
   * against, and raising it is the account administrator's.
   */
  canSetGroupLimit: boolean;
  onRefresh: () => void;
}) {
  const [name, setName] = useState('');
  const [groupSearch, setGroupSearch] = useState('');
  const [userSearch, setUserSearch] = useState('');
  const [selected, setSelected] = useState<string>('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  /*
   * Which row is working, not merely that something is. The first version set a
   * single boolean and disabled every control on the tab, so one appointment
   * froze forty rows and the person who clicked could not tell which of them
   * they had clicked.
   */
  const run = async (what: string, f: () => Promise<void>) => {
    setBusy(what);
    setErr(null);
    try { await f(); } catch (e) { setErr((e as Error).message || '操作に失敗しました'); }
    finally { setBusy(null); }
  };

  const create = () => {
    if (!name.trim()) { setErr('グループ名を入力してください'); return; }
    run('create', async () => { await onCreate(name.trim()); setName(''); setSelected(name.trim()); });
  };

  const remove = (g: UserGroup) => {
    /*
     * The confirmation says what survives, because the fear is the opposite —
     * "delete the group" reads as "delete these people". It does not: the
     * accounts, their projects and their usage are untouched and simply belong
     * to nothing until they are placed again.
     */
    if (!window.confirm(
      `グループ「${g.name}」を削除しますか？\n\n所属している${g.memberCount}人のアカウントは削除されません。` +
      `プロジェクトも使用量もそのまま残り、どのグループにも属さない状態になります。`
    )) return;
    run(`del:${g.name}`, async () => { await onDelete(g.name); if (selected === g.name) setSelected(''); });
  };

  const shownGroups = useMemo(() => {
    const q = groupSearch.trim().toLowerCase();
    return q ? groups.filter((g) => g.name.toLowerCase().includes(q)) : groups;
  }, [groups, groupSearch]);

  const group = groups.find((g) => g.name === selected) ?? null;

  /*
   * Members first, then everyone else. A directory sorted by name puts the
   * people this group already has among fifty it does not, and the question the
   * pane answers is "who is in this group".
   */
  const shownUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    const matched = q
      ? users.filter((u) =>
          u.displayName.toLowerCase().includes(q)
          || u.email.toLowerCase().includes(q)
          || (u.group ?? '').toLowerCase().includes(q))
      : users;
    if (!group) return matched;
    const rank = (u: CognitoUser) => (u.group === group.name ? 0 : u.group ? 2 : 1);
    return [...matched].sort((a, b) => rank(a) - rank(b)
      || (a.displayName || a.username).localeCompare(b.displayName || b.username));
  }, [users, userSearch, group]);

  const members = group ? users.filter((u) => u.group === group.name) : [];

  return (
    <div className="adm-tabpane adm-tabpane--groups">
      <div className="adm-toolbar">
        <input
          className="adm-input adm-input--search"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') create(); }}
          placeholder="新しいグループ名"
          maxLength={63}
          aria-label="新しいグループ名"
        />
        <button className="adm-btn adm-btn--primary adm-btn--sm" type="button" onClick={create} disabled={busy !== null}>
          作成
        </button>
        <button className="adm-btn adm-btn--secondary adm-btn--sm" type="button" onClick={onRefresh} disabled={busy !== null}>
          更新
        </button>
        <span className="adm-toolbar__note">
          {groups.length}グループ ・ {users.filter((u) => u.group).length}/{users.length}人が所属
        </span>
      </div>

      {err && <div className="adm-error-banner" role="alert">{err}</div>}

      <div className="adm-split">
        <div className="adm-split__col">
          <div className="adm-split__head">
            グループ
            <span className="adm-split__note">選ぶと右で所属を編集できます</span>
          </div>
          <div className="adm-subbar">
            <input
              className="adm-input adm-input--sm"
              type="search"
              value={groupSearch}
              onChange={(e) => setGroupSearch(e.target.value)}
              placeholder="グループを検索"
              aria-label="グループを検索"
            />
          </div>
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th className="adm-th">グループ</th>
                  <th className="adm-th">管理者</th>
                  <th className="adm-th adm-th--num adm-th--run">人数</th>
                  <th className="adm-th adm-th--num adm-th--money">今月の金額 / 予算</th>
                  <th className="adm-th adm-th--act"></th>
                </tr>
              </thead>
              <tbody>
                {shownGroups.map((g) => {
                  const admin = users.find((u) => u.username === g.admin);
                  return (
                    <tr
                      key={g.name}
                      className={`adm-tr adm-tr--click${g.name === selected ? ' adm-tr--active' : ''}`}
                      onClick={() => setSelected(g.name)}
                    >
                      <td className="adm-td"><span className="adm-email">{g.name}</span></td>
                      <td className="adm-td adm-td--muted">
                        {g.admin ? (admin?.displayName || g.admin) : '（未設定）'}
                      </td>
                      <td className="adm-td adm-td--num">{g.memberCount}</td>
                      {/*
                        The whole group against the whole group's budget.
                        Members are each inside their own and the tenant can
                        still be past the figure the account is billed on, which
                        is the reason this number exists.
                      */}
                      <td className="adm-td adm-td--num" onClick={(e) => e.stopPropagation()}>
                        {g.monthlyLimit === null || g.monthlyLimit === undefined ? (
                          <span className="adm-uid" title="読み取れませんでした">—</span>
                        ) : (
                          /*
                            Stacked, because two amounts and an edit button on
                            one line do not fit a column in a split pane: the
                            cell clipped with an ellipsis, and what it clipped
                            was the budget — so the column read as one number
                            with a slash after it.

                            Inside the editor rather than beside it, because the
                            editor is the only thing that knows whether it is
                            open — and open, all three do not fit at all.
                          */
                          <BudgetEditor
                            value={g.monthlyLimit}
                            onSave={(limit) => onSetLimit(g.name, limit)}
                            disabled={!canSetGroupLimit}
                          >
                            <span className="adm-money-cell">
                              <span className="adm-money-figure">
                                {typeof g.cost === 'number' ? usd(g.cost) : '—'}
                              </span>
                              <span className="adm-money-of">
                                {g.monthlyLimit === UNLIMITED ? '予算 無制限' : `／ ${usd(asMoney(g.monthlyLimit))}`}
                              </span>
                            </span>
                          </BudgetEditor>
                        )}
                      </td>
                      <td className="adm-td adm-td--action">
                        <button
                          className="adm-btn adm-btn--danger-ghost adm-btn--sm"
                          type="button"
                          onClick={(e) => { e.stopPropagation(); remove(g); }}
                          disabled={busy !== null}
                        >
                          {busy === `del:${g.name}` ? '…' : '削除'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {shownGroups.length === 0 && (
                  <tr>
                    <td colSpan={5} className="adm-td adm-td--empty">
                      {groupSearch ? '該当するグループがありません' : 'グループがありません'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="adm-split__col">
          <div className="adm-split__head">
            {group ? `${group.name} の所属` : '所属'}
            {group && (
              <span className="adm-split__note">
                {members.length}人
              </span>
            )}
          </div>

          {!group ? (
            <div className="adm-empty">左でグループを選ぶと、所属の追加・解除と管理者の指名ができます</div>
          ) : (
            <>
              <div className="adm-subbar">
                {/*
                  The one pulldown, and the composer's own component rather than
                  a native <select>, so every menu in the product is the same
                  control. It is the right shape here: one administrator chosen
                  out of the members, which is a list that fits in a menu.
                */}
                <Dropdown
                  label="管理者"
                  value={group.admin ?? ''}
                  disabled={busy !== null}
                  options={[
                    { id: '', label: '（未設定）', description: 'このグループには管理者がいません' },
                    ...members.map((u) => ({
                      id: u.username,
                      label: u.displayName || u.username,
                      description: u.email,
                    })),
                  ]}
                  onChange={(id) => run('admin', () => onSetAdmin(group.name, id || null))}
                />
                <input
                  className="adm-input adm-input--sm"
                  type="search"
                  value={userSearch}
                  onChange={(e) => setUserSearch(e.target.value)}
                  placeholder="ユーザー名/メールアドレスで検索"
                  aria-label="ユーザー名/メールアドレスで検索"
                />
              </div>
              <div className="adm-table-wrap">
                <table className="adm-table">
                  <thead>
                    <tr>
                      <th className="adm-th">ユーザー</th>
                      {/*
                        `adm-th--model` is the 84px width for a column holding a
                        model name, and this one holds a group name — 「エンジニアリング」
                        was being clipped to fit a column sized for 「haiku」.
                      */}
                      <th className="adm-th adm-th--grp">所属グループ</th>
                      <th className="adm-th adm-th--num adm-th--money">今月の金額 / 予算</th>
                      <th className="adm-th adm-th--models">利用可能モデル</th>
                      <th className="adm-th adm-th--act2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownUsers.map((u) => {
                      const here = u.group === group.name;
                      const working = busy === `mem:${u.username}` || busy === `adm:${u.username}`;
                      /** Removing this person would leave the group unadministered. */
                      const stranding = here && u.isGroupAdmin && members.length > 1;
                      /*
                       * Joined by email, which is this pool's Cognito username
                       * as well — a usage row is keyed by `sub` and a directory
                       * row is not, and the address is the only field both hold.
                       */
                      const row = usage.find((x) => x.email && x.email === u.email);
                      return (
                        <tr key={u.username} className={`adm-tr${here ? ' adm-tr--active' : ''}`}>
                          <td className="adm-td">
                            <span className="adm-email">{u.displayName || u.username}</span>
                            <span className="adm-uid">{u.email}</span>
                          </td>
                          <td className="adm-td adm-td--muted">
                            {here
                              ? (u.isGroupAdmin ? '管理者' : '所属')
                              : u.group
                                ? u.group
                                : '—'}
                          </td>
                          {/*
                            What this member has spent against what they are
                            allowed. Same shape as the group's own cell one pane
                            over, because it is the same question one level down
                            — and dividing the group's budget among its people is
                            what that total exists for.
                          */}
                          <td className="adm-td adm-td--num">
                            {row ? (
                              <BudgetEditor
                                value={row.monthlyLimit}
                                onSave={(limit) => onSetUserLimit(row.userId, limit)}
                              >
                                <span className="adm-money-cell">
                                  <span className="adm-money-figure">
                                    {typeof row.cost === 'number' ? usd(row.cost) : '—'}
                                  </span>
                                  <span className="adm-money-of">
                                    {row.monthlyLimit === UNLIMITED ? '予算 無制限' : `／ ${usd(asMoney(row.monthlyLimit))}`}
                                  </span>
                                </span>
                              </BudgetEditor>
                            ) : (
                              <span className="adm-uid" title="使用量の記録が見つかりません">—</span>
                            )}
                          </td>
                          {/*
                            Which models this member may pick, set from the list
                            they are already being managed in. The same control
                            as the user tab's, over the same route, because a
                            second way of expressing the same setting is a second
                            thing to keep in step.
                          */}
                          <td className="adm-td">
                            {row ? (
                              <ModelPicker
                                models={row.allowedModels ?? ALL_MODELS}
                                onSave={(models) => onSetModels(row.userId, models)}
                              />
                            ) : (
                              <span className="adm-uid" title="使用量の記録が見つかりません">—</span>
                            )}
                          </td>
                          <td className="adm-td adm-td--action">
                            {/*
                              Straight to this person's projects.
                              Reaching them meant leaving the group, opening the
                              projects tab and typing the name into its search —
                              from a screen that already knows exactly who is
                              meant. Only when there is a usage row: the projects
                              tab is addressed by `sub`, which is what that row
                              carries and the directory entry does not.
                            */}
                            {row && (
                              <button
                                className="adm-btn adm-btn--secondary adm-btn--sm"
                                type="button"
                                onClick={() => onOpenProjects(row.userId)}
                                title={`${u.displayName || u.username} のプロジェクトを開く`}
                              >
                                プロジェクト
                              </button>
                            )}
                            {here ? (
                              <>
                                {/*
                                  Appointing from the member's own row, so the
                                  order stops mattering — the server adds the
                                  membership with the appointment.
                                */}
                                {!u.isGroupAdmin && (
                                  <button
                                    className="adm-btn adm-btn--secondary adm-btn--sm"
                                    type="button"
                                    disabled={busy !== null}
                                    onClick={() => run(`adm:${u.username}`, () => onSetAdmin(group.name, u.username))}
                                  >
                                    管理者にする
                                  </button>
                                )}
                                {/*
                                  The administrator cannot simply be taken out.
                                  Doing it left exactly what it says: a group
                                  with people in it and nobody able to open the
                                  panel for them, from a button that mentioned
                                  none of that. The group is handed over first —
                                  「管理者にする」 on any other member does it in
                                  one call and leaves this person a plain member.

                                  The last member is not blocked: an empty group
                                  has nothing to administer, and refusing there
                                  would be a dead end rather than a safeguard.
                                  The server refuses on the same rule; this is
                                  the half that says so before the click.
                                */}
                                <button
                                  className="adm-btn adm-btn--danger-ghost adm-btn--sm"
                                  type="button"
                                  disabled={busy !== null || stranding}
                                  title={stranding
                                    ? `${u.displayName || u.username} は「${group.name}」の管理者です。ほかの${members.length - 1}人が残るため、先に別のメンバーを管理者にしてください。`
                                    : undefined}
                                  onClick={() => run(`mem:${u.username}`, () => onSetMembership(u.username, null))}
                                >
                                  {working ? '…' : '外す'}
                                </button>
                              </>
                            ) : (
                              <button
                                className="adm-btn adm-btn--secondary adm-btn--sm"
                                type="button"
                                disabled={busy !== null}
                                onClick={() => run(`mem:${u.username}`, () => onSetMembership(u.username, group.name))}
                              >
                                {working ? '…' : u.group ? 'ここへ移す' : '追加'}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {shownUsers.length === 0 && (
                      <tr>
                        <td colSpan={5} className="adm-td adm-td--empty">
                          {userSearch ? '該当するユーザーがいません' : 'ユーザーがいません'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}


