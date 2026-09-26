/**
 * The users tab: the accounts, with their group, budget, permitted models and display name.
 */
import { useState } from 'react';
import { type UserUsageSummary, type CognitoUser, type ModelId } from '../../hooks/useAdmin';
import { UNLIMITED, ALL_MODELS, formatDate, asMoney, usd } from './shared';
import { BudgetEditor, ModelPicker, NameEditor } from './editors';

export function UsersTab({
  cognitoUsers,
  cognitoLoading,
  usage,
  onRefresh,
  onCreateUser,
  onDeleteUser,
  onToggleEnabled,
  onRename,
  onSetLimit,
  onSetModels,
  canManageAccounts,
  canSetLimits,
}: {
  cognitoUsers: CognitoUser[];
  cognitoLoading: boolean;
  /**
   * The usage rows, for the limits they carry.
   *
   * Joined on the email address, because a Cognito listing has no `sub` on it
   * and the usage row has both. The pool's username IS the email, so the join
   * is on a unique key rather than on a name.
   *
   * A row is present for every account now, spending or not — the server fills
   * a zero one in. Before that, the accounts an administrator most wants to
   * configure, the new ones, were the ones with no row to configure.
   */
  usage: UserUsageSummary[];
  onRefresh: () => void;
  onCreateUser: (displayName: string, email: string, temporaryPassword: string) => Promise<void>;
  onDeleteUser: (username: string) => Promise<void>;
  onToggleEnabled: (username: string, enable: boolean) => Promise<void>;
  onRename: (username: string, displayName: string) => Promise<void>;
  onSetLimit: (userId: string, limit: number) => Promise<void>;
  onSetModels: (userId: string, models: ModelId[]) => Promise<void>;
  /** False for a group administrator: adding and removing accounts is not theirs. */
  canManageAccounts: boolean;
  /** And neither is what the account may spend. */
  canSetLimits: boolean;
}) {
  const usageOf = (email: string): UserUsageSummary | undefined =>
    usage.find((u) => u.email && u.email.toLowerCase() === email.toLowerCase());
  const [showForm, setShowForm] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deletingUsername, setDeletingUsername] = useState<string | null>(null);
  const [togglingUsername, setTogglingUsername] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const filtered = cognitoUsers.filter((u) => {
    if (!search) return true;
    const q = search.toLowerCase();
    // The name is what the list is read by now, so it has to be searchable —
    // otherwise typing what you can see finds nothing.
    return u.displayName.toLowerCase().includes(q)
      || u.email.toLowerCase().includes(q)
      || u.username.toLowerCase().includes(q);
  });

  const handleCreate = async () => {
    if (!displayName.trim() || !email.trim() || !password.trim()) {
      setFormError('ユーザー名・メールアドレス・仮パスワードは必須です');
      return;
    }
    setCreating(true);
    setFormError(null);
    try {
      await onCreateUser(displayName.trim(), email.trim(), password.trim());
      setDisplayName('');
      setEmail('');
      setPassword('');
      setShowForm(false);
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (username: string) => {
    if (!window.confirm(`ユーザー「${username}」を削除しますか？この操作は取り消せません。`)) return;
    setDeletingUsername(username);
    try {
      await onDeleteUser(username);
    } catch (e) {
      alert(`削除に失敗しました: ${(e as Error).message}`);
    } finally {
      setDeletingUsername(null);
    }
  };

  const handleToggle = async (u: CognitoUser) => {
    setTogglingUsername(u.username);
    try {
      await onToggleEnabled(u.username, !u.enabled);
    } catch (e) {
      alert(`${u.enabled ? '無効化' : '有効化'}に失敗しました: ${(e as Error).message}`);
    } finally {
      setTogglingUsername(null);
    }
  };

  const statusCounts = {
    total: cognitoUsers.length,
    confirmed: cognitoUsers.filter((u) => u.status === 'CONFIRMED').length,
    pending: cognitoUsers.filter((u) => u.status === 'FORCE_CHANGE_PASSWORD').length,
    disabled: cognitoUsers.filter((u) => !u.enabled).length,
  };

  return (
    <div className="adm-users-tab">
      {cognitoUsers.length > 0 && (
        <div className="adm-summary">
          <div className="adm-summary__item">
            <span className="adm-summary__val">{statusCounts.total}</span>
            <span className="adm-summary__label">合計</span>
          </div>
          <div className="adm-summary__item">
            <span className="adm-summary__val">{statusCounts.confirmed}</span>
            <span className="adm-summary__label">確認済み</span>
          </div>
          {statusCounts.pending > 0 && (
            <div className="adm-summary__item adm-summary__item--warn">
              <span className="adm-summary__val">{statusCounts.pending}</span>
              <span className="adm-summary__label">パスワード変更待ち</span>
            </div>
          )}
          {statusCounts.disabled > 0 && (
            <div className="adm-summary__item adm-summary__item--muted">
              <span className="adm-summary__val">{statusCounts.disabled}</span>
              <span className="adm-summary__label">無効</span>
            </div>
          )}
        </div>
      )}

      <div className="adm-users-toolbar">
        {canManageAccounts && (
          <button
            onClick={() => { setShowForm((s) => !s); setFormError(null); }}
            className="adm-btn adm-btn--primary"
            type="button"
          >
            {showForm ? '− キャンセル' : '+ ユーザーを追加'}
          </button>
        )}
        <button onClick={onRefresh} disabled={cognitoLoading} className="adm-btn adm-btn--secondary" type="button">
          {cognitoLoading ? '更新中…' : '更新'}
        </button>
      </div>

      {showForm && canManageAccounts && (
        <div className="adm-create-form">
          <div className="adm-create-form__title">新規ユーザー作成</div>
          {formError && <div className="adm-error-banner" role="alert">{formError}</div>}
          <div className="adm-create-form__row">
            <div className="adm-field">
              <label className="adm-field__label" htmlFor="adm-name">ユーザー名</label>
              <input
                id="adm-name"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="adm-input"
                placeholder="山田 太郎"
                maxLength={64}
                autoComplete="off"
              />
            </div>
            <div className="adm-field">
              <label className="adm-field__label" htmlFor="adm-email">メールアドレス（ログインID）</label>
              <input
                id="adm-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="adm-input"
                placeholder="user@example.com"
                autoComplete="off"
              />
            </div>
            <div className="adm-field">
              <label className="adm-field__label" htmlFor="adm-password">仮パスワード</label>
              <input
                id="adm-password"
                type="text"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="adm-input"
                placeholder="Temp@1234"
                autoComplete="off"
              />
            </div>
            <button
              onClick={handleCreate}
              disabled={creating}
              className="adm-btn adm-btn--primary adm-btn--create"
              type="button"
            >
              {creating ? '作成中…' : '作成'}
            </button>
          </div>
        </div>
      )}

      <div className="adm-toolbar">
        <input
          type="search"
          className="adm-search"
          placeholder="ユーザー名/メールアドレスで検索"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="ユーザー検索"
        />
      </div>

      {cognitoLoading && cognitoUsers.length === 0 ? (
        <div className="adm-loading">
          <span className="adm-spinner" />
          <span>読み込み中…</span>
        </div>
      ) : (
        <div className="adm-table-wrap">
          <table className="adm-table" aria-label="Cognitoユーザー一覧">
            <thead>
              <tr>
                <th className="adm-th">ユーザー</th>
                <th className="adm-th">メールアドレス（ログインID）</th>
                <th className="adm-th">所属グループ</th>
                <th className="adm-th">月間予算</th>
                <th className="adm-th">利用可能モデル</th>
                <th className="adm-th">ステータス</th>
                <th className="adm-th">有効</th>
                <th className="adm-th adm-th--date">作成日時</th>
                <th className="adm-th adm-th--act"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((u) => (
                <tr key={u.username} className="adm-tr">
                  <td className="adm-td">
                    <NameEditor user={u} onRename={onRename} />
                  </td>
                  <td className="adm-td adm-td--muted">{u.email || u.username}</td>
                  {/*
                    What the account is allowed, where the account is managed.
                    These three lived on the usage tab, which is about what was
                    spent — a different question, asked at a different moment.
                  */}
                  <td className="adm-td adm-td--muted">
                    {u.group ?? '—'}
                    {u.isGroupAdmin && <span className="adm-badge adm-badge--neutral">管理者</span>}
                  </td>
                  {(() => {
                    const row = usageOf(u.email || u.username);
                    if (!row) {
                      /* No usage row means the directory and the ledger disagree
                         about this account, which is a state worth showing rather
                         than two blank cells. */
                      return (
                        <td className="adm-td adm-td--muted" colSpan={2} title="使用量の記録が見つかりません">
                          —
                        </td>
                      );
                    }
                    return (
                      <>
                        <td className="adm-td">
                          {/* The figure goes inside, so it steps aside while the
                              editor is open rather than sharing the line — see
                              the note on BudgetEditor's `children`. */}
                          <BudgetEditor
                            value={row.monthlyLimit}
                            onSave={(limit) => onSetLimit(row.userId, limit)}
                            disabled={!canSetLimits}
                          >
                            <span className="adm-limit-val">
                              {row.monthlyLimit === UNLIMITED ? '無制限' : usd(asMoney(row.monthlyLimit))}
                            </span>
                          </BudgetEditor>
                        </td>
                        <td className="adm-td">
                          {/* Recorded here, enforced in the pipeline: these boxes
                              change what the server will honour, not merely what
                              the composer offers. */}
                          <ModelPicker
                            models={row.allowedModels ?? ALL_MODELS}
                            onSave={(models) => onSetModels(row.userId, models)}
                          />
                        </td>
                      </>
                    );
                  })()}
                  <td className="adm-td">
                    <span className={`adm-badge ${u.status === 'CONFIRMED' ? 'adm-badge--success' : u.status === 'FORCE_CHANGE_PASSWORD' ? 'adm-badge--warn' : 'adm-badge--neutral'}`}>
                      {u.status === 'FORCE_CHANGE_PASSWORD' ? 'PW変更待ち' : u.status}
                    </span>
                  </td>
                  <td className="adm-td">
                    <button
                      onClick={() => handleToggle(u)}
                      disabled={togglingUsername === u.username}
                      className={`adm-toggle-btn${u.enabled ? ' adm-toggle-btn--on' : ' adm-toggle-btn--off'}`}
                      title={u.enabled ? 'クリックで無効化' : 'クリックで有効化'}
                      type="button"
                    >
                      {togglingUsername === u.username ? '…' : u.enabled ? '有効' : '無効'}
                    </button>
                  </td>
                  <td className="adm-td adm-td--muted">{formatDate(u.createdAt)}</td>
                  <td className="adm-td adm-td--action">
                    {canManageAccounts && (
                    <button
                      onClick={() => handleDelete(u.username)}
                      disabled={deletingUsername === u.username}
                      className="adm-btn adm-btn--danger-ghost adm-btn--sm"
                      type="button"
                      aria-label={`${u.displayName || u.email || u.username} を削除`}
                    >
                      {deletingUsername === u.username ? '…' : '削除'}
                    </button>
                    )}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={9} className="adm-td adm-td--empty">
                    {search ? '該当するユーザーがいません' : 'ユーザーがいません'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

