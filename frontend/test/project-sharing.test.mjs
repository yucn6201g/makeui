// Sharing, as the screens show it: the 共有 tab, the share panel, what a viewer
// is and is not offered, who wrote what, and the top bar's buttons.
//
//   node test/project-sharing.test.mjs      (from frontend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { ADMIN_FILES, readAdminPanel } from './lib/admin-source.mjs';
import { APP_FILES, readApp } from './lib/app-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/utils/projects/projectFilter.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist-test/project-sharing.filter.test.mjs')}"`,
  { stdio: 'pipe', cwd: root }
);
const pf = await import(pathToFileURL(path.join(root, 'dist-test/project-sharing.filter.test.mjs')).href);
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// --- three tabs ------------------------------------------------------------------------
{
  const p = (id, extra = {}) => ({ projectId: id, userId: 'me', name: id, createdAt: '', updatedAt: '', ...extra });
  const own = p('own', { access: { role: 'owner', ownerId: 'me', ownerName: 'me' } });
  const sharedByMe = p('shared-by-me', { sharedAt: '2026-09-23', access: { role: 'owner', ownerId: 'me', ownerName: 'me' } });
  const sharedWithMe = p('shared-with-me', { access: { role: 'view', ownerId: 'x', ownerName: 'X' } });
  const archivedShared = p('archived', { sharedAt: '2026-09-23', archivedAt: '2026-09-23' });
  const all = [own, sharedByMe, sharedWithMe, archivedShared];
  check('a project of one\'s own is on プロジェクト', pf.tabOf(own), 'active');
  check('one this account shared is on 共有', pf.tabOf(sharedByMe), 'shared');
  check('and so is one shared with it', pf.tabOf(sharedWithMe), 'shared');
  check('the archive wins over sharing', pf.tabOf(archivedShared), 'archive');
  const ids = (tab) => pf.visibleProjects(all, { query: '', framework: 'all', tab }).map((x) => x.projectId);
  check('each tab shows its own', [ids('active'), ids('shared'), ids('archive')], [['own'], ['shared-by-me', 'shared-with-me'], ['archived']]);
  check('the two-tab form still reads', pf.visibleProjects(all, { query: '', framework: 'all', archived: true }).map((x) => x.projectId), ['archived']);
  check('counts per tab', pf.frameworkCounts(all, 'shared').all, 2);
}

// --- the list ----------------------------------------------------------------------------
{
  const list = read('src/components/project-list/ProjectList.tsx');
  check('the tabs are プロジェクト, 共有, アーカイブ', /\['active', 'プロジェクト', activeCount\][\s\S]{0,200}\['shared', '共有', sharedCount\][\s\S]*アーカイブ/.test(list), true);
  check('a shared card says whose it is and the role', /\{project\.access\?\.ownerName\} さんから共有[\s\S]{0,200}ROLE_LABELS\[role\]/.test(list), true);
  check('and the owner\'s says it is shared', /project\.sharedAt \? \(\s*<div className="project-list__card-share">共有中<\/div>/.test(list), true);
  check('a viewer gets no star', /!archived && !selecting && canWrite &&/.test(list), true);
}

// --- the share panel -------------------------------------------------------------------------
{
  const panel = read('src/components/workspace/ShareButton.tsx');
  check('people are searched by name, email or group', /ユーザー名・メールアドレス・グループ名で検索/.test(panel), true);
  check('three roles to choose from', /SHARE_ROLES\.map/.test(panel), true);
  check('only owner and full add people', /const manage = canManageShares\(effectiveRole\);[\s\S]*\{manage && \(\s*<div className="share-panel__add">/.test(panel), true);
  check('a member may leave', /isSelf && \([\s\S]{0,200}共有から外れる/.test(panel), true);
  check('the public link is still here, not for viewers', /<LinkSection html=\{html\} title=\{title\} allowed=\{canWrite\(role\)\} \/>/.test(panel), true);
  const roles = read('src/utils/projects/shareRoles.ts');
  check('the roles are named as asked', /full: '全権限',\s*edit: '編集',\s*view: '閲覧',/.test(roles), true);
  const hook = read('src/hooks/useShares.ts');
  check('the panel talks to the share routes', ['/shares`', '/users/search${search}`', '/share-groups`', "method: 'PUT'", "method: 'DELETE'"].every((s) => hook.includes(s)), true);
}

// --- the workspace ---------------------------------------------------------------------------
{
  const app = readApp();
  check('the role comes from the project', /const projectRole = project\.access\?\.role \?\? 'owner';\s*const readOnly = projectRole === 'view';/.test(app), true);
  check('a viewer gets a note, not a prompt box', /\{readOnly \? \([\s\S]{0,400}閲覧権限で共有されたプロジェクトです/.test(app), true);
  check('and no editor', [/onEditFile=\{readOnly \? undefined : directEdit\.editSource\}/.test(app), /onEdit=\{readOnly \? undefined : directEdit\.editStyle\}/.test(app)], [true, true]);
  check('and no rename', /readOnly=\{readOnly\}\s*aria-label="プロジェクト名"/.test(app), true);
  check('and no thread save', /if \(readOnly\) return;/.test(app), true);
  check('every prompt records its author', /author: selfAuthor,/.test(app), true);
  check('and a shared thread shows it', /isSharedProject && msg\.role === 'user' && msg\.author\?\.name/.test(app), true);
  check('the share button is always there, with the project and role', /<ShareButton html=\{displayHtml \?\? null\} title=\{projectTitle\} projectId=\{project\.projectId\} role=\{project\.access\?\.role \?\? 'owner'\} \/>/.test(app), true);
  check('a version is loaded through its project', /loadVersion\(versionId, project\.projectId\)/.test(app), true);
  const chat = read('src/hooks/useChatHistory.ts');
  check('the author is saved with the message', /author, timestamp,\s*\}\)\);/.test(chat), true);
  check('versions name who ran them', /v\.actorName \? `\$\{v\.actorName\}：` : ''/.test(read('src/utils/projects/versionOptions.ts')), true);
}

// --- the top bar: Admin and Logout are header buttons like ZIP and 共有 -------------------------
{
  const app = readApp();
  const list = read('src/components/project-list/ProjectList.tsx');
  const admin = readAdminPanel();
  check('Logout in the workspace', /className="app__header-btn app__logout"/.test(app), true);
  check('Logout on the list', /className="app__header-btn project-list__logout"/.test(list), true);
  check('Admin', /className="app__header-btn admin-panel__toggle"/.test(admin), true);
  const css = read('src/index.css');
  check('one height whatever the label', /\.app__header-btn \{[^}]*min-height: var\(--control-h\);/.test(css), true);
  check('and no size of their own', /\.admin-panel__toggle \{\s*padding:/.test(css) || /\.project-list__logout \{\s*font-size:/.test(css), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
