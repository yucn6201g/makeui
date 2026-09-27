import type { Page, Route } from '@playwright/test';
import { CORS_HEADERS } from './http';
import { reactProject } from './project';

/**
 * MakeUI's API, answered in the test.
 *
 * Holds just enough state to behave like the real one across a test — projects,
 * versions, chat messages and jobs — and records every request, so a test can
 * check what the screen actually sent:
 *
 *   expect(api.last('POST', '/generate')?.body.preset).toBe('carbon');
 *
 * A route a test did not expect is answered 404 and recorded in `unhandled`;
 * the test fixture fails the test when anything is left there.
 */
export const API_ORIGIN = 'http://api.e2e.test';

export interface ApiRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
  headers: Record<string, string>;
}

export interface ApiReply {
  status?: number;
  body?: unknown;
}

type Handler = (req: ApiRequest, match: RegExpMatchArray) => ApiReply | Promise<ApiReply>;

/** One step of a job as GET /jobs/{id} reports it. */
export interface JobStep {
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: Record<string, unknown>;
  error?: string;
  streamPhase?: string;
  streamTail?: string;
}

export interface MockProject {
  projectId: string;
  userId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  lastHtml?: string;
  outputKind?: 'react' | 'vue';
  preset?: string;
  model?: string;
  archivedAt?: string;
  [key: string]: unknown;
}

const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();

/** A completed job's result, in the shape the job runner writes. */
export function completedResult(html = reactProject(), extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    html,
    qualityScore: 86,
    metadata: {
      modelTier: 'haiku',
      preset: 'none',
      effort: 'standard',
      tokenUsage: { inputTokens: 1200, outputTokens: 3400 },
    },
    ...extra,
  };
}

/** The job most tests want: queued, then running, then done. */
export const JOB_OK: JobStep[] = [
  { status: 'running', streamPhase: 'code-assembler', streamTail: 'export default function App() {' },
  { status: 'completed', result: completedResult() },
];

export class MockApi {
  readonly calls: ApiRequest[] = [];
  readonly unhandled: string[] = [];
  readonly projects: MockProject[] = [];
  readonly versions: Array<Record<string, unknown>> = [];
  readonly messages = new Map<string, unknown[]>();
  /** Who the share search can find. Made-up people. */
  readonly people = [
    { userId: 'sub-hanako', name: '佐藤 花子', email: 'hanako@example.invalid' },
    { userId: 'sub-jiro', name: '鈴木 次郎', email: 'jiro@example.invalid' },
  ];
  private readonly shares = new Map<string, Array<Record<string, unknown>>>();
  private sharesOf(projectId: string) {
    return this.shares.get(projectId) ?? [];
  }
  /** What the next job started by /generate, /modify or /plan will report, poll by poll. */
  nextJob: JobStep[] = JOB_OK;
  private readonly jobs = new Map<string, { steps: JobStep[]; polls: number }>();
  private readonly routes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [];
  private seq = 0;

  constructor() {
    this.defaults();
  }

  /** Answers METHOD path with a fixed reply or a handler. Later registrations win. */
  on(method: string, path: string | RegExp, reply: ApiReply | Handler): this {
    const pattern = typeof path === 'string' ? new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) : path;
    const handler: Handler = typeof reply === 'function' ? reply : () => reply;
    this.routes.unshift({ method: method.toUpperCase(), pattern, handler });
    return this;
  }

  /** Every request made to METHOD path, oldest first. */
  all(method: string, path: string | RegExp): ApiRequest[] {
    return this.calls.filter((c) => c.method === method.toUpperCase() && (typeof path === 'string' ? c.path === path : path.test(c.path)));
  }

  last(method: string, path: string | RegExp): ApiRequest | undefined {
    return this.all(method, path).at(-1);
  }

  /** A project that already exists when the page opens. */
  addProject(fields: Partial<MockProject> = {}): MockProject {
    const n = this.projects.length + 1;
    const project: MockProject = {
      projectId: `p-e2e-${n}`,
      userId: 'sub-e2e',
      name: `プロジェクト ${n}`,
      createdAt: iso(n * 3_600_000),
      updatedAt: iso(n * 3_600_000),
      outputKind: 'react',
      ...fields,
    };
    this.projects.push(project);
    return project;
  }

  async install(page: Page): Promise<void> {
    await page.route(`${API_ORIGIN}/**`, (route) => this.handle(route));
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS_HEADERS });
    const url = new URL(request.url());
    let body: unknown = null;
    const raw = request.postData();
    if (raw) {
      try { body = JSON.parse(raw); } catch { body = raw; }
    }
    const req: ApiRequest = { method: request.method(), path: url.pathname, query: url.searchParams, body, headers: request.headers() };
    this.calls.push(req);
    const reply = await this.respond(req);
    await route.fulfill({
      status: reply.status ?? 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify(reply.body ?? {}),
    });
  }

  /**
   * The answer to one request, without a browser. The page's requests come
   * through here, and so do the contract test's (test/e2e-contract.test.mjs),
   * which holds these answers to the real handlers' shapes.
   */
  async respond(req: ApiRequest): Promise<ApiReply> {
    const route = this.routes.find((r) => r.method === req.method && r.pattern.test(req.path));
    if (route) return route.handler(req, req.path.match(route.pattern)!);
    this.unhandled.push(`${req.method} ${req.path}`);
    return { status: 404, body: { error: 'e2e: not mocked' } };
  }

  /** Every route this mock answers, as METHOD and a path pattern. */
  routeList(): Array<{ method: string; pattern: RegExp }> {
    return this.routes.map(({ method, pattern }) => ({ method, pattern }));
  }

  private startJob(): ApiReply {
    const jobId = `job-e2e-${++this.seq}`;
    this.jobs.set(jobId, { steps: this.nextJob, polls: 0 });
    return { status: 202, body: { jobId, status: 'pending' } };
  }

  private defaults(): void {
    this.on('GET', '/models', {
      body: {
        models: [
          { id: 'auto', label: '自動', version: null, modelId: '' },
          { id: 'haiku', label: 'Haiku', version: '4.5', modelId: '' },
          { id: 'sonnet', label: 'Sonnet', version: '5', modelId: '' },
        ],
        default: 'auto',
      },
    });
    this.on('GET', '/usage', {
      body: {
        displayName: 'E2E 利用者',
        history: [],
        currentUsage: 0,
        limit: 10_000_000,
        tokensUsed: 0,
        cost: 0,
        costEstimated: false,
        requestsUsed: 0,
        group: null,
        groupBudget: null,
        allowedModels: ['auto', 'haiku', 'sonnet'],
      },
    });

    // Projects
    this.on('GET', '/projects', () => ({ body: { projects: this.projects } }));
    this.on('POST', '/projects', (req) => {
      const project = this.addProject({ name: String(req.body?.name ?? 'Untitled'), createdAt: iso(), updatedAt: iso() });
      // Newest first, as the list shows it.
      this.projects.unshift(this.projects.pop()!);
      return { status: 201, body: project };
    });
    this.on('PUT', /^\/projects\/([^/]+)$/, (req, m) => {
      const project = this.projects.find((p) => p.projectId === m[1]);
      if (!project) return { status: 404, body: { error: 'Project not found' } };
      const { archived, favourite, ...fields } = req.body ?? {};
      Object.assign(project, fields, { updatedAt: iso() });
      // Stored as when, not whether, as project-service does; an archived project is no favourite.
      if (archived === true) Object.assign(project, { archivedAt: iso(), favouritedAt: undefined });
      if (archived === false) delete project.archivedAt;
      if (favourite === true) project.favouritedAt = iso();
      if (favourite === false) delete project.favouritedAt;
      return { body: { message: 'Project updated' } };
    });
    this.on('DELETE', /^\/projects\/([^/]+)$/, (_req, m) => {
      const at = this.projects.findIndex((p) => p.projectId === m[1]);
      if (at >= 0) this.projects.splice(at, 1);
      return { body: { message: 'Project deleted' } };
    });
    this.on('GET', /^\/projects\/([^/]+)\/preview$/, (_req, m) => ({
      body: { html: this.projects.find((p) => p.projectId === m[1])?.lastHtml ?? null },
    }));
    this.on('GET', /^\/projects\/([^/]+)\/messages$/, (_req, m) => ({ body: { messages: this.messages.get(m[1]) ?? [] } }));
    this.on('PUT', /^\/projects\/([^/]+)\/messages$/, (req, m) => {
      this.messages.set(m[1], req.body?.messages ?? []);
      return { body: { message: 'Messages saved' } };
    });
    // Sharing, as handlers/share-routes.ts answers it.
    this.on('GET', /^\/projects\/([^/]+)\/shares$/, (_req, m) => ({
      body: { role: 'owner', self: 'sub-e2e', owner: { userId: 'sub-e2e', name: 'E2E 利用者' }, shares: this.sharesOf(m[1]) },
    }));
    this.on('PUT', /^\/projects\/([^/]+)\/shares$/, (req, m) => {
      const person = this.people.find((p) => p.userId === req.body?.id);
      const label = req.body?.type === 'group' ? String(req.body.id) : person?.name ?? String(req.body?.id);
      const grants = this.sharesOf(m[1]).filter((g) => !(g.type === req.body?.type && g.id === req.body?.id));
      grants.push({ type: req.body?.type, id: req.body?.id, label, email: person?.email, role: req.body?.role, grantedByName: 'E2E 利用者', grantedAt: iso() });
      this.shares.set(m[1], grants);
      return { body: { shares: grants } };
    });
    this.on('DELETE', /^\/projects\/([^/]+)\/shares\/(user|group)\/([^/]+)$/, (_req, m) => {
      const grants = this.sharesOf(m[1]).filter((g) => !(g.type === m[2] && g.id === decodeURIComponent(m[3])));
      this.shares.set(m[1], grants);
      return { body: { shares: grants } };
    });
    this.on('GET', '/users/search', (req) => {
      const q = (req.query.get('q') ?? '').trim();
      // Two characters at least, as the handler requires.
      const users = q.length < 2 ? [] : this.people.filter((p) => p.name.includes(q) || p.email.includes(q));
      return { body: { users } };
    });
    this.on('GET', '/share-groups', { body: { groups: [{ name: 'design', memberCount: 4 }] } });

    // Publishing: the page is stored and a link comes back.
    this.on('POST', '/publish', () => {
      const siteId = `site-e2e-${++this.seq}`;
      return { body: { siteId, url: `https://share.e2e.test/${siteId}/index.html`, domain: 'https://share.e2e.test' } };
    });
    // Refining the brief (orchestration/edit/refine-prompt.ts): the rewrite and what it added.
    this.on('POST', '/refine-prompt', (req) => ({
      body: { prompt: `${req.body?.prompt ?? ''}\n\n画面: 一覧・詳細・設定の3画面。`, notes: ['画面の一覧を明記しました'] },
    }));

    // Versions
    this.on('GET', '/versions', (req) => {
      const projectId = req.query.get('projectId');
      return { body: { versions: this.versions.filter((v) => !projectId || v.projectId === projectId) } };
    });
    this.on('POST', '/versions', (req) => {
      const version = { versionId: `v-e2e-${++this.seq}`, createdAt: iso(), score: 0, preset: 'none', model: 'auto', prompt: '', ...req.body };
      this.versions.unshift(version);
      return { status: 201, body: { versionId: version.versionId, score: version.score } };
    });
    this.on('GET', /^\/versions\/([^/]+)$/, (_req, m) => {
      const version = this.versions.find((v) => v.versionId === m[1]);
      return version ? { body: version } : { status: 404, body: { error: 'Version not found' } };
    });

    // Jobs
    this.on('POST', '/generate', () => this.startJob());
    this.on('POST', '/modify', () => this.startJob());
    this.on('POST', '/plan', () => this.startJob());
    this.on('GET', /^\/jobs\/([^/]+)$/, (_req, m) => {
      const job = this.jobs.get(m[1]);
      if (!job) return { status: 404, body: { error: 'Job not found' } };
      const step = job.steps[Math.min(job.polls, job.steps.length - 1)];
      job.polls += 1;
      return {
        body: {
          jobId: m[1],
          status: step.status,
          result: step.result,
          error: step.error,
          createdAt: iso(),
          updatedAt: iso(),
          events: [],
          streamTail: step.streamTail,
          streamChars: step.streamTail?.length,
          streamPhase: step.streamPhase,
        },
      };
    });
  }
}
