/**
 * The admin panel: its tabs, and who may see each one.
 *
 * Each tab is its own file in this folder; shared.ts holds the formatting and
 * period helpers they all use, and editors.tsx the inline editors.
 */
import { useState, useEffect, useMemo, useRef } from 'react';
import { useAdmin, type ModelInventory } from '../../hooks/useAdmin';
import { useAuth } from '../../auth/AuthProvider';
import { isSuperAdmin } from '../../utils/account/membership';
import { modelRows, modelCount } from '../../utils/admin/modelRows';
import { SlidingIndicator } from '../common/SlidingIndicator';
import { usePresence } from '../../hooks/usePresence';
import { Period, THIS_MONTH } from './shared';
import { UsageTab } from './UsageTab';
import { UsersTab } from './UsersTab';
import { ProjectsTab } from './ProjectsTab';
import { GroupsTab } from './GroupsTab';
import { ModelsTab } from './ModelsTab';

export function AdminPanel() {
  const { fetchModelInventory, users, loading, error, fetchUsers, setUserLimit, setUserAllowedModels, setGroupLimit, cognitoUsers, cognitoLoading, cognitoError, fetchCognitoUsers, createUser, renameUser, deleteUser, toggleUserEnabled, fetchProjects, fetchProjectVersions, fetchVersion, groups, fetchGroups, createGroup, deleteGroup, setMembership, setGroupAdmin } = useAdmin();
  const { membership } = useAuth();
  /*
   * What this administrator may change, decided once. Every control below reads
   * it rather than asking about roles itself — the server applies the same rule,
   * so a control drawn by mistake would be refused rather than obeyed, but a
   * control that is drawn and then refused is a worse experience than one that
   * was never offered.
   */
  const superAdmin = isSuperAdmin(membership);
  const [visible, setVisible] = useState(false);
  const [tab, setTab] = useState<'usage' | 'models' | 'users' | 'projects' | 'groups'>('usage');
  /*
   * An account the projects tab has been sent to, from the group member list.
   *
   * The token rises on every request so that asking for the SAME person twice
   * still opens them — a bare id would be equal to the one already showing and
   * the tab would sit there looking broken.
   */
  const [openProjectsOn, setOpenProjectsOn] = useState<{ userId: string; token: number } | null>(null);
  /*
   * The model inventory, held here rather than inside the tab.
   *
   * The chip beside the tab counts the models the tab lists, and the panel is
   * where every other chip's number already lives. Reporting it up from the pane
   * is the shape the projects badge had and was removed for: a child calling a
   * parent's setState on every render.
   *
   * Cheap enough to fetch with the panel: three SSM reads behind a five-minute
   * cache. The Parameter Store listing that made this expensive is gone.
   */
  const [inventory, setInventory] = useState<ModelInventory | null>(null);
  const [inventoryBusy, setInventoryBusy] = useState(false);
  /** Which request is the current one. See the effect below for why not a flag. */
  const inventoryRequestRef = useRef(0);
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  /*
   * Every account's projects added up, for the tab's badge.
   *
   * The badge used to be whatever the pane happened to be showing — one
   * account's total, and nothing at all until somebody had been chosen. The
   * other three tabs count the whole account, so a number that meant "the
   * person I am currently reading" sat in the same row of chips meaning
   * something else entirely.
   *
   * Null when no row carries the field, which is a response from a server
   * older than the count. Zero would read as an account with no work in it.
   */
  /*
   * The model tab's own period. The usage tab answers 「誰が」 and this one
   * answers 「何に」, and moving one should not move the other.
   */
  const [modelPeriod, setModelPeriod] = useState<Period>(THIS_MONTH);
  const modelTable = useMemo(
    () => (inventory ? modelRows(inventory.series, inventory.tiers) : []),
    [inventory]
  );

  const totalProjects = useMemo(() => {
    const counted = users.filter((u) => typeof u.projectCount === 'number');
    return counted.length === 0 ? null : counted.reduce((n, u) => n + (u.projectCount ?? 0), 0);
  }, [users]);
  /*
   * The period the usage tab reports on, held here because the fetch is here.
   * Defaults to this month, which is what the server answers when asked for
   * nothing.
   */
  const [period, setPeriod] = useState<Period>(THIS_MONTH);
  const openProjectsFor = (userId: string) => {
    setOpenProjectsOn({ userId, token: Date.now() });
    setTab('projects');
  };

  /*
   * Keyed on the period as well as on opening, so changing it refetches — and
   * NOT on `users.length`, which was the guard against refetching on every
   * render and would now also stop a period change from ever loading a month
   * that happens to have the same number of rows.
   */
  useEffect(() => {
    if (visible) fetchUsers(period);
  }, [visible, period, fetchUsers]);

  /*
   * Once the panel opens, not once the tab does: the chip beside 「モデル」 is
   * drawn while another tab is showing, so the count has to exist before the tab
   * is ever chosen. Super-admin only, because the route is.
   *
   * A counter, not a `cancelled` flag closed over by the effect, and NOTHING the
   * effect sets appears in its own dependency list. The first version guarded on
   * `inventoryBusy` and listed it as a dependency, which deadlocks on every
   * open:
   *
   *   the effect runs and sets busy -> the dependency changed, so React tears
   *   the effect down (cancelled = true) and re-runs it -> the re-run returns at
   *   the `|| inventoryBusy` guard -> the first fetch resolves into handlers
   *   that are all `if (!cancelled)`, so busy is never cleared.
   *
   * The tab then shows its spinner for ever, which is exactly what it did.
   * A superseded request can no longer clear the flag for a newer one, and a
   * re-run — the token refreshing is the real case — simply supersedes.
   */
  useEffect(() => {
    if (!visible || !superAdmin) return;
    const id = ++inventoryRequestRef.current;
    const current = () => inventoryRequestRef.current === id;
    setInventoryBusy(true);
    setInventoryError(null);
    fetchModelInventory(modelPeriod)
      .then((d) => { if (current()) setInventory(d); })
      .catch((e) => { if (current()) setInventoryError((e as Error).message || '読み込みに失敗しました'); })
      .finally(() => { if (current()) setInventoryBusy(false); });
  }, [visible, superAdmin, modelPeriod, fetchModelInventory]);

  useEffect(() => {
    if (visible && (tab === 'users' || tab === 'groups') && cognitoUsers.length === 0) {
      fetchCognitoUsers();
    }
    if (visible && tab === 'groups') fetchGroups().catch(() => {});
  }, [visible, tab, cognitoUsers.length, fetchCognitoUsers, fetchGroups]);

  // Kept on screen while it slides away — see usePresence.
  const sheet = usePresence(visible);

  if (!sheet.mounted) {
    return (
      <button
        onClick={() => { setVisible(true); }}
        className="app__header-btn admin-panel__toggle"
        aria-label="管理画面を開く"
        title="Admin"
        type="button"
      >
        Admin
      </button>
    );
  }

  return (
    <>
      <div className="adm-overlay" onClick={() => setVisible(false)} aria-hidden="true" data-state={sheet.state} />
      <div className="adm-panel" role="region" aria-label="管理画面" data-state={sheet.state}>
        {/* Header */}
        <div className="adm-header">
          <div className="adm-header__left">
            <span className="adm-header__icon">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="1" y="1" width="6" height="6" rx="1" fill="currentColor" opacity="0.7"/>
                <rect x="9" y="1" width="6" height="6" rx="1" fill="currentColor" opacity="0.7"/>
                <rect x="1" y="9" width="6" height="6" rx="1" fill="currentColor" opacity="0.7"/>
                <rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor"/>
              </svg>
            </span>
            <h2 className="adm-header__title">Admin Panel</h2>
            {/*
              A group administrator's panel shows their group and nothing else,
              and saying so is the difference between "there is one user" and
              "there is one user IN MY GROUP".
            */}
            {!superAdmin && membership.group && (
              <span className="adm-header__scope">{membership.group}</span>
            )}
          </div>
          <div className="adm-header__actions">
            <button
              /* Wrapped: `fetchUsers` takes a period now, and a bare handler
                 would hand it the click event as one. */
              onClick={() => (tab === 'users' ? fetchCognitoUsers() : fetchUsers(period))}
              disabled={tab === 'users' ? cognitoLoading : loading}
              className="adm-btn adm-btn--secondary adm-btn--sm"
              type="button"
            >
              {(tab === 'usage' ? loading : cognitoLoading) ? '更新中…' : '更新'}
            </button>
            <button onClick={() => setVisible(false)} className="adm-btn adm-btn--ghost adm-btn--icon" aria-label="閉じる" type="button">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="adm-tabs motion-track">
          <SlidingIndicator active={tab} selector=".adm-tab--active" />
          <button
            className={`adm-tab${tab === 'usage' ? ' adm-tab--active' : ''}`}
            onClick={() => setTab('usage')}
            type="button"
          >
            使用量
            {users.length > 0 && <span className="adm-tab-badge">{users.length}</span>}
          </button>
          {/*
            Beside 使用量 rather than inside it. The money on that tab is a
            consequence of what is on this one — which model each tier resolves
            to, what the price table says, whether it is enforced — and none of
            it was visible anywhere: answering 「今月なぜこの金額なのか」 meant an
            `aws ssm get-parameter` on a machine with credentials.

            Super-admin only, like the groups tab: it reports the account's own
            infrastructure, which is not a group administrator's business.
          */}
          {superAdmin && (
            <button
              className={`adm-tab${tab === 'models' ? ' adm-tab--active' : ''}`}
              onClick={() => setTab('models')}
              type="button"
            >
              モデル
              {modelTable.length > 0 && (
                <span className="adm-tab-badge">{modelCount(modelTable)}</span>
              )}
            </button>
          )}
          <button
            className={`adm-tab${tab === 'users' ? ' adm-tab--active' : ''}`}
            onClick={() => setTab('users')}
            type="button"
          >
            ユーザー管理
            {cognitoUsers.length > 0 && <span className="adm-tab-badge">{cognitoUsers.length}</span>}
          </button>
          <button
            className={`adm-tab${tab === 'projects' ? ' adm-tab--active' : ''}`}
            onClick={() => setTab('projects')}
            type="button"
          >
            プロジェクト
            {totalProjects !== null && <span className="adm-tab-badge">{totalProjects}</span>}
          </button>
          {superAdmin && (
            <button
              className={`adm-tab${tab === 'groups' ? ' adm-tab--active' : ''}`}
              onClick={() => setTab('groups')}
              type="button"
            >
              グループ
              {groups.length > 0 && <span className="adm-tab-badge">{groups.length}</span>}
            </button>
          )}
        </div>

        {/* Error banner */}
        {error && tab === 'usage' && <div className="adm-error-banner" role="alert">{error}</div>}
        {cognitoError && tab === 'users' && <div className="adm-error-banner" role="alert">{cognitoError}</div>}

        {/* Tab content */}
        <div className="adm-body motion-swap" key={tab}>
          {tab === 'usage' && (
            <UsageTab users={users} loading={loading} period={period} onPeriodChange={setPeriod} />
          )}
          {tab === 'models' && superAdmin && (
            <ModelsTab
              inventory={inventory}
              period={modelPeriod}
              onPeriodChange={setModelPeriod}
              loading={inventoryBusy}
              error={inventoryError}
            />
          )}
          {tab === 'groups' && superAdmin && (
            <GroupsTab
              groups={groups}
              users={cognitoUsers}
              onCreate={createGroup}
              onDelete={deleteGroup}
              onSetMembership={setMembership}
              onSetAdmin={setGroupAdmin}
              onSetLimit={setGroupLimit}
              onSetUserLimit={setUserLimit}
              canSetGroupLimit={superAdmin}
              usage={users}
              onSetModels={setUserAllowedModels}
              onOpenProjects={openProjectsFor}
              onRefresh={() => { fetchGroups().catch(() => {}); fetchCognitoUsers(); }}
            />
          )}
          {tab === 'projects' && (
            <ProjectsTab
              users={users}
              openOn={openProjectsOn}
              fetchProjects={fetchProjects}
              fetchProjectVersions={fetchProjectVersions}
              fetchVersion={fetchVersion}
            />
          )}
          {tab === 'users' && (
            <UsersTab
              cognitoUsers={cognitoUsers}
              cognitoLoading={cognitoLoading}
              usage={users}
              onRefresh={fetchCognitoUsers}
              onCreateUser={createUser}
              onDeleteUser={deleteUser}
              onToggleEnabled={toggleUserEnabled}
              onRename={renameUser}
              onSetLimit={setUserLimit}
              onSetModels={setUserAllowedModels}
              canManageAccounts={superAdmin}
              /*
               * A group administrator divides their own group's budget. The
               * server narrows it to their members either way — this only
               * decides whether the control is drawn.
               */
              canSetLimits={true}
            />
          )}
        </div>
      </div>
    </>
  );
}
