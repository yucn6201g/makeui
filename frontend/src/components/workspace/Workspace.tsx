/**
 * The project workspace: chat and composer, preview, code, versions and sharing
 * for the one project that is open.
 */
import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { uiImagesForSend, captionsForSend, roomForImages, MAX_UI_IMAGES } from '../../utils/requests/uiImages';
import { promptProblem, oversizedImages, MAX_IMAGE_BYTES } from '../../utils/requests/requestLimits';
import { titleFromResult, isUnnamed } from '../../utils/projects/projectTitle';
import { titleWidthEm } from '../../utils/projects/titleWidth';
import { useAuth } from '../../auth/AuthProvider';
import { normalizePreset, PRESETS } from '../../utils/projects/presets';
import { Preview, type DeviceKind } from './Preview';
import { isOutputKind, detectKind, type OutputKind } from '../../utils/preview/frameworkKind';
import { CodeEditor } from './CodeEditor';
import { AdminPanel } from '../admin/AdminPanel';
import { PromptTemplates } from './PromptTemplates';
import { CHAT_SUGGESTIONS } from '../../data/promptTemplates';
import { CSSInspector } from './CSSInspector';
import { ShareButton } from './ShareButton';
import { VersionDiff } from '../version-diff/VersionDiff';
import { useGenerate } from '../../hooks/useGenerate';
import type { ScoreParts } from '../../hooks/useGenerate';
import { useDirectEdit } from '../../hooks/useDirectEdit';
import { useModify } from '../../hooks/useModify';
import { useUsage } from '../../hooks/useUsage';
import { useHistory } from '../../hooks/useHistory';
import { useModels } from '../../hooks/useModels';
import {
  setActiveJob,
  getActiveJob,
  clearActiveJob,
  setActivePhases,
  getActivePhases,
} from '../../utils/requests/activeJob';
import { ActivityCard } from './ActivityCard';
import { Dropdown, type DropdownOption } from '../common/Dropdown';
import { versionOptions } from '../../utils/projects/versionOptions';
import { usePlan } from '../../hooks/usePlan';
import { proposalBeingAnswered } from '../../utils/chat/planRevision';
import { useChatHistory } from '../../hooks/useChatHistory';
import {
  ANY_ATTACHMENT_ACCEPT,
  attachmentProblem,
  describeAttachment,
  extractPdfText,
  isImageAttachment,
  isPdf,
  MAX_ATTACHMENT_CHARS,
  type AttachedData,
} from '../../utils/requests/dataAttachment';
import { UsageMenu } from '../common/UsageMenu';
import { ProjectThumbnail } from '../project-list/ProjectThumbnail';
import { formatReply, inlineSpans } from '../../utils/chat/formatReply';
import { ReasoningTranscript } from './ReasoningTranscript';
import { trimPhasesForStorage, readStoredPhases, type PhaseEntry } from '../../utils/chat/phaseTranscript';
import { createStickToBottom, type StickToBottom } from '../../utils/chat/stickToBottom';
import { readAnchor } from '../../utils/editing/sourceAnchors';
import { runtimeRepairInstruction, runtimeRepairMessage } from '../../utils/chat/runtimeRepair';
import { findingFixInstruction, findingFixMessage } from '../../utils/chat/findingFix';
import { deleteElement, moveElement, elementText, setElementText } from '../../utils/editing/structuralEdit';
import { splitHtmlToFiles } from '../../utils/preview/virtualFs';
import { toProjectFiles } from '../../utils/preview/scaffold';
import { createZip, zipFileName } from '../../utils/preview/zip';
import { type Project } from '../../hooks/useProjects';
import { localPartOf } from '../../utils/account/displayName';
import { useRefinePrompt } from '../../hooks/useRefinePrompt';
import { isOlderRubric } from '../../utils/projects/scoreScale';
import { SlidingIndicator } from '../common/SlidingIndicator';

/**
 * A text box whose value is the document's until the user takes it.
 *
 * Keyed by its initial value at the call site, so selecting a different element
 * remounts it. Holding a draft across selections would show one element's text
 * in another's field, and committing it would write it there.
 */
function TextField({ initial, onCommit }: { initial: string; onCommit: (text: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? initial;
  const commit = () => {
    if (draft !== null && draft !== initial) onCommit(draft);
    setDraft(null);
  };
  return (
    <div className="app__structural-text">
      <label className="app__structural-label" htmlFor="mkui-text">本文</label>
      <input
        id="mkui-text"
        className="app__structural-input"
        value={value}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); (e.target as HTMLInputElement).blur(); } }}
      />
    </div>
  );
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  html?: string;
  score?: number;
  toolsUsed?: string[];
  tokenUsage?: { inputTokens: number; outputTokens: number };
  /**
   * A plan awaiting approval. Carries the specification that produced it, so
   * accepting it builds what was reviewed rather than re-deriving a design from
   * the prompt.
   */
  proposal?: { plan: string; spec: string; prompt: string };
  /** Who wrote it — shown on a shared project's thread. */
  author?: { id: string; name: string };
  /**
   * What produced this reply: the tier that actually ran and the design system
   * it was bound to.
   *
   * The tier is the resolved one, not the one picked in the composer — with
   * `auto` selected those differ, and "自動" does not answer "which model built
   * this". Optional because replies from before this existed have no answer,
   * and inventing one from the current composer state would be a guess dressed
   * as a record.
   */
  runInfo?: { modelTier: string; preset: string; effort?: string; scoreVerified?: boolean; scoreParts?: ScoreParts };
  /**
   * The run that produced this reply, step by step.
   *
   * The transcript used to live only in the in-progress card, which is removed
   * the moment the run finishes — so the account of how the UI was built was
   * destroyed by the UI arriving. Everything anyone might want to look back at
   * (which step took the time, what it decided, where the tokens went) was on
   * screen for the length of the run and then gone.
   *
   * Snapshotted onto the message so it survives, and so it survives a reload:
   * the thread is persisted, and a transcript that vanished on refresh would be
   * the same bug with a longer fuse.
   */
  phases?: PhaseEntry[];
  timestamp: number;
}

/** Tier ids to the names shown against a reply. */
const MODEL_LABELS: Record<string, string> = {
  haiku: 'Haiku',
  sonnet: 'Sonnet',
  opus: 'Opus',
};

/**
 * Read off the selector rather than restated here.
 *
 * A second copy of these names is a second thing to forget when a preset is
 * renamed, and the chat thread would then disagree with the control the user
 * picked it from.
 *
 * The compact name, not the full one. Measured at a 380px chat column:
 * 「デジタル庁デザインシステム」 pushed the metadata row to three lines, taller
 * than the reply it annotates. `chip` is the name already shown on the
 * composer, so the thread and the control still agree; the full label goes in
 * the tooltip.
 */
const presetChip = (id: string): string =>
  PRESETS.find((p) => p.id === id)?.chip ?? id;
const presetFullLabel = (id: string): string =>
  PRESETS.find((p) => p.id === id)?.label ?? id;

/** Explains what each tier is for, in the dropdown. */
const MODEL_NOTES: Record<string, string> = {
  auto: '依頼内容から自動で選択。迷ったらこれ',
  haiku: '最速・最安。下書きや小さな変更に',
  sonnet: '速度と品質のバランス。通常はこれ',
  opus: '最高品質。複雑な画面や作り込みに',
};

/**
 * HTML is gone. It was one self-contained file, which shared none of the
 * machinery the project formats share — no file layout, no module graph, no
 * per-file repair — and every one of those paths carried an "or else it is HTML"
 * branch for an output nobody chose for real work. Stored HTML projects still
 * open; nothing new is generated that way.
 */
const OUTPUT_KINDS: DropdownOption[] = [
  { id: 'react', label: 'React', description: 'TypeScript + JSX。複数ファイル・状態管理つき' },
  { id: 'vue', label: 'Vue', description: 'Vue 3 の単一ファイルコンポーネント（script setup）' },
];

/**
 * The three viewports, named after what they are meant to look like.
 *
 * Widths are the real logical widths of the devices, so a breakpoint that misfires
 * on an actual iPhone misfires here too — a 375px column that merely *looks* narrow
 * would not have caught it.
 */
const DEVICES = [
  { id: 'desktop' as const, label: 'Desktop', title: 'デスクトップ（可変幅）' },
  { id: 'tablet' as const, label: 'Tablet', title: 'iPad — 820 × 1180' },
  { id: 'mobile' as const, label: 'Mobile', title: 'iPhone — 393 × 852' },
];

/**
 * How much a build may spend, plus plan mode, in one menu.
 *
 * Two axes are folded into one control on purpose: nobody wants to set "effort"
 * and "plan or not" separately, and plan mode has no effort of its own — it runs
 * the design phase and stops. Internally they stay separate, so approving a plan
 * returns to whichever effort was chosen rather than silently to the default.
 *
 * The descriptions say what is given up. 下書き skips the design phase and
 * everything after generation, and that shows: fewer screens wired together,
 * more of the model's own defaults. Saying so on the menu is cheaper than
 * having someone discover it in the output.
 *
 * No mode names a model any more. There were four, three of which fixed one and
 * disabled the picker — see the note where that table stood, and the
 * measurement that killed it.
 */
/*
 * 思考モード stood here, commented out, because it fixed Opus and this account
 * cannot invoke any Opus that stays in Japan — the agreement is accepted and
 * the throughput allocation is still zero, on a quota that cannot be raised
 * without AWS. See backend config/withdrawn.ts, which carries the measurement.
 *
 * There is nothing left to comment out. A mode no longer chooses a model, so
 * the only thing Opus can make unavailable is Opus, which the picker already
 * refuses on the same list.
 */
const CHAT_MODES: DropdownOption[] = [
  { id: 'draft', label: '下書き', description: '1回だけ生成します。設計・検証・修復なし。速くて安いぶん、動かないことがあります' },
  { id: 'checked', label: '仕上げ', description: '設計から検証・修復まで通します。時間はかかります' },
  { id: 'plan', label: 'プラン', description: '先に構成案を出します。承認してから生成します' },
];

/**
 * What the four modes before these were called.
 *
 * A reply written months ago carries the name that existed then, and the chip
 * on it has to say something. Mapped rather than left to fall through: an
 * unrecognised id renders as no chip at all, which would quietly turn every
 * historical 節約 build into one indistinguishable from a checked one.
 */
const LEGACY_MODES: Record<string, string> = {
  economy: '下書き',
  fast: '下書き',
  // Empty on purpose: 「仕上げ」 is what most replies are, and a chip repeating
  // it on every one would bury the case that matters — a build that skipped the
  // checks, which otherwise reads as the model having got worse.
  standard: '',
  thinking: '',
};

/**
 * The build efforts, i.e. everything in the menu that is not plan mode.
 *
 * `checked` rather than `build`: `chatMode` in this file is already
 * `'build' | 'plan'`, and one word carrying two meanings three hundred lines
 * apart is how `setChatMode('build'); setEffort('build')` comes to read as one
 * statement instead of two about different things.
 */
export type Effort = 'draft' | 'checked';

/*
 * `MODE_MODEL` stood here: a table locking 節約 to Haiku, 高速 to Sonnet and
 * 思考 to Opus, with the model picker disabled whenever one applied.
 *
 * It made the menu and the picker two controls for one decision, and the
 * decision it took was the wrong one to attach to a mode. Measured over 30
 * days, 節約 (Haiku) failed to compile 67% of the time against 高速's 25%, and
 * every failure bought an emergency repair pass — so the mode named for thrift
 * emitted 85k output tokens to 高速's 50k, and the mode named for speed came
 * out FASTER. Two ends of a dial that can swap places are not a dial.
 *
 * The mode decides how much checking runs; the picker decides the model. Every
 * combination the four old modes could express is still reachable, and two they
 * could not: a checked build on a cheap model, which is the obvious thing to
 * want.
 */

/**
 * The mode chip on a reply, or empty for the default.
 *
 * `standard` returns nothing on purpose. It is what most replies are, and a chip
 * repeating it on every one of them would bury the case that matters — a build
 * that skipped stages, which otherwise reads as the model having got worse.
 */
/**
 * What the number is made of, in the place someone reads the number.
 *
 * The score sums two unlike things — a checklist of the project's file layout
 * and what a browser found when it opened the result — and the composite has
 * been read as a judgement about the UI. Measured on two runs of the same brief
 * a day apart: 84 and 69, where most of the difference was two absent
 * directories on the LARGER project, which reached all five of its screens with
 * no console errors. So the halves are named here rather than left summed.
 *
 * A tooltip rather than a second badge: the split matters when someone is asking
 * why a number moved, and not before.
 */
const scoreTitle = (run: ChatMessage['runInfo']): string => {
  const parts = run?.scoreParts;
  const unverified = run && run.scoreVerified === false
    ? '静的検査のみのスコアです。ブラウザ実行による減点（死んだ操作・空の枠・到達不能な画面・コントラスト）が含まれないため、検証ありのスコアと直接は比較できません'
    : 'ブラウザ実行の計測を含むスコアです';
  /*
   * A score from before the rubric changed is not on the new scale.
   *
   * 22 checks that every measured document passed carried 99 of 176 points and
   * are now gates, so the same project reads lower than it did — measured on 45
   * stored documents, 51-96 became 30-91. An old number sitting in the thread
   * above a new one invites exactly the comparison that is not available, so it
   * says which scale it is on. Scale 1 is anything without `rubric`: the field
   * shipped with the change.
   */
  const oldScale = `

旧スケールで採点された点数です。現在のスコアとは基準が違うため直接は比較できません`;
  if (!parts) return unverified + oldScale;
  /*
   * Against the current scale, not against 2. This read `< 2` since the first
   * change and was never moved: a score from scale 2 or 3 sat in the thread
   * unmarked above one from a later scale.
   */
  if (isOlderRubric(parts.rubric)) return unverified + oldScale;
  const c = `契約（ファイル構成・ルーティング・型）: ${Math.round(parts.contract.earned)}/${parts.contract.possible}`;
  const r = parts.runtime
    ? `動作（実際に開いて計測）: ${Math.round(parts.runtime.earned)}/${parts.runtime.possible}` +
      (parts.runtime.penalty > 0 ? `、減点 −${parts.runtime.penalty}` : '')
    : '動作: 未計測';
  return `${c}
${r}

${unverified}`;
};

/**
 * One line of a reply, with its markdown shown as formatting rather than as
 * punctuation.
 *
 * React nodes rather than `innerHTML`: the text is the model's, and a chat
 * message is the one place in this app where model output reaches the DOM on
 * every single run. `markdown.ts` escapes first and passes no raw HTML through,
 * which makes it safe for the editor's document preview — but not having the
 * question at all is better than answering it correctly here.
 */
const renderInline = (line: string): React.ReactNode =>
  inlineSpans(line).map((span, i) => {
    if (span.kind === 'bold') return <strong key={i}>{span.text}</strong>;
    if (span.kind === 'code') return <code className="app__chat-code" key={i}>{span.text}</code>;
    return <span key={i}>{span.text}</span>;
  });

const effortLabel = (id: string | undefined): string => {
  if (!id || id === 'checked') return '';
  if (id in LEGACY_MODES) return LEGACY_MODES[id];
  return CHAT_MODES.find((m) => m.id === id)?.label ?? '';
};
const effortFullLabel = (id: string | undefined): string =>
  CHAT_MODES.find((m) => m.id === id)?.description
  ?? (id && id in LEGACY_MODES ? `${LEGACY_MODES[id] || '仕上げ'}（旧「${id}」）` : '');

export interface WorkspaceProps {
  project: Project;
  onBackToProjects: () => void;
  onUpdateProject: (projectId: string, updates: { name?: string; lastHtml?: string; preset?: string; model?: string }) => Promise<void>;
  fetchProjectPreview: (projectId: string) => Promise<string | null>;
}

export function Workspace({ project, onBackToProjects, onUpdateProject, fetchProjectPreview }: WorkspaceProps) {
  /*
   * Only what is said after the project opens rises into the thread. The history
   * loaded with it is already there: animating forty messages at once on every
   * open was one of the heavier moments in the app (2026-09-24).
   */
  const [openedAt] = useState(() => Date.now());
  const { userEmail, isAdmin, logout, token } = useAuth();
  const { refinement, refining, message: refineMessage, refine, clear: clearRefinement } = useRefinePrompt();
  const [inputText, setInputText] = useState('');
  // Older projects may carry a preset that has since been retired — fall back to 'none'
  const [preset, setPreset] = useState(() => normalizePreset(project.preset));
  const [model, setModel] = useState<'auto' | 'haiku' | 'sonnet' | 'opus'>((project.model as 'auto' | 'haiku' | 'sonnet' | 'opus') ?? 'auto');
  const [image, setImage] = useState<string | null>(null);
  /*
   * Further pictures, for putting IN the UI.
   *
   * Kept apart from `image` because the two are read differently and the split
   * is the cheap half of the feature: `image` is the one attachment the design
   * phase and the build actually LOOK at, which is what "take the layout and
   * palette from this" needs. These are described once and placed by marker, so
   * five of them cost one call instead of one per pipeline stage.
   *
   * The rule the composer applies, stated where it is easy to find: attach ONE
   * picture and nothing changes — it stays the reference-or-content attachment
   * it has always been, and the model decides which from the request. Attach
   * MORE and all of them become content, because nobody attaches five design
   * references, and treating the first of five as one would let a product photo
   * decide the palette.
   */
  const [extraImages, setExtraImages] = useState<string[]>([]);
  /*
   * What each attached picture shows, when the user says so.
   *
   * Indexed the way the composer holds the pictures: slot 0 is `image`, the rest
   * follow `extraImages`. They know what the picture is and the captioner can
   * only guess — a described picture never reaches the vision call, so a fully
   * described set costs nothing to understand.
   */
  const [imageNotes, setImageNotes] = useState<string[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  /*
   * The request the running generation was started with.
   *
   * Only for naming the project when the document does not name itself — a ref
   * rather than state because nothing renders from it, and reading it back off
   * the thread would mean finding "the last user message that was not an edit",
   * which is a question the thread cannot answer after a rebuild.
   */
  const genPromptRef = useRef('');
  /*
   * The user's own data, for the screens to be built from.
   *
   * Separate from `image` because they are different things travelling
   * different routes: the image is 5MB of base64 that goes via S3 and is looked
   * at, this is text that rides in the request and is read.
   */
  const [dataFile, setDataFile] = useState<AttachedData | null>(null);
  /* Reading a PDF loads a 2.3MB parser and then parses; both are visible waits. */
  const [pdfReading, setPdfReading] = useState(false);
  const [selectedSelector, setSelectedSelector] = useState<string | null>(null);
  /** `<path>:<line>` for the selected element, when the preview could trace it. */
  const [selectedAnchor, setSelectedAnchor] = useState<string | null>(null);
  /** Why a structural edit did not happen, when it did not. */
  const [structuralNote, setStructuralNote] = useState<string | null>(null);

  /**
   * Delete or reorder the selected element, in the source.
   *
   * Not `display: none` and not `order:` — both would be one line here and both
   * produce a document that looks right and is wrong: the element stays in the
   * file, the next model edit still sees it, and the export still ships it.
   *
   * The refusals are shown rather than swallowed. `structuralEdit` declines
   * whenever the relationship it would have to assume is not visible in the
   * source — a sibling separated by text, an element that does not close — and a
   * button that silently does nothing is the failure this session has spent its
   * time removing.
   */
  const applyStructural = (op: 'delete' | 'up' | 'down') => {
    setStructuralNote(null);
    const at = readAnchor(selectedAnchor);
    if (!at || !displayHtml) return;
    const file = splitHtmlToFiles(displayHtml).find((f) => f.path === at.path);
    if (!file) {
      setStructuralNote(`${at.path} を読み込めませんでした。`);
      return;
    }
    const next = op === 'delete'
      ? deleteElement(file.content, at.line)
      : moveElement(file.content, at.line, op === 'up' ? -1 : 1);
    if (next === null) {
      setStructuralNote(
        op === 'delete'
          ? 'この要素の範囲を特定できませんでした。'
          : 'この向きに動かせません。隣が要素でないか、端にあります。'
      );
      return;
    }
    if (!directEdit.editSource(at.path, next)) {
      setStructuralNote(`${at.path} には書き込めません。`);
      return;
    }
    setSelectedSelector(null);
    setSelectedAnchor(null);
  };
  const [loadedHtml, setLoadedHtml] = useState<string | null>(project.lastHtml ?? null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [previewTab, setPreviewTab] = useState<'preview' | 'code'>('preview');
  const [device, setDevice] = useState<DeviceKind>('desktop');
  const { result, score, runInfo: genRunInfo, abandoned: genAbandoned, tokenUsage, isGenerating, plan, streamPhase, phases, error, generate, reset, stop: stopGenerate, resume: resumeGenerate, jobId: generateJobId } = useGenerate();
  const { modifiedHtml, runInfo: modifyRunInfo, toolsUsed, tokenUsage: modifyTokenUsage, isModifying, plan: modifyPlan, streamPhase: modifyStreamPhase, phases: modifyPhases, error: modifyError, modify, reset: resetModify, stop: stopModify, resume: resumeModify, jobId: modifyJobId } = useModify();
  const { result: planResult, isPlanning, phases: planPhases, error: planError, plan: proposePlan, resume: resumePlan, reset: resetPlan, stop: stopPlan, jobId: planJobId } = usePlan();
  const { usage, answered: usageAnswered, refresh: refreshUsage } = useUsage();
  /*
   * This account's role on the project — its own, or one shared with it. A
   * viewer reads and does nothing else; the server refuses anything more, and
   * the workspace does not offer it. On a shared project each message says who
   * wrote it.
   */
  const projectRole = project.access?.role ?? 'owner';
  const readOnly = projectRole === 'view';
  const isSharedProject = projectRole !== 'owner' || Boolean(project.sharedAt);
  const selfAuthor = { id: userEmail ?? '', name: usage?.displayName || localPartOf(userEmail) };
  const { versions, fetchVersions, loadVersion } = useHistory();
  const { loadMessages, saveMessages, saveFailed } = useChatHistory();
  // The selected version's id, or '' for the live document. An id rather than an
  // index because the list is refreshed whenever a run finishes.
  const [selectedVersionId, setSelectedVersionId] = useState<string>('');
  const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:8080';

  const [projectTitle, setProjectTitle] = useState(project.name);
  const modifyAttemptHtmlRef = useRef<string | null>(null);
  /**
   * The document last written to the project record.
   *
   * Both completion effects depend on `preset`/`model` so they can persist the
   * settings alongside the output — which means changing either afterwards re-runs
   * them. Without this guard, touching the preset once after an edit re-persisted
   * the older generate output on top of the newer modified one.
   */
  const persistedHtmlRef = useRef<string | null>(project.lastHtml ?? null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatThreadRef = useRef<HTMLDivElement | null>(null);
  /**
   * Held in state as well as in the ref, so the effect that attaches the
   * follower re-runs when the element changes. A ref alone never notifies, which
   * leaves the listeners on whatever node was there at mount.
   */
  const [threadEl, setThreadEl] = useState<HTMLDivElement | null>(null);
  const setChatThread = useCallback((el: HTMLDivElement | null) => {
    chatThreadRef.current = el;
    setThreadEl(el);
  }, []);

  /**
   * Bring the end of the thread into view, and nothing else.
   *
   * This was `chatEndRef.current.scrollIntoView()`, which scrolls EVERY
   * scrollable ancestor including the document — so adding a message while the
   * settings drawer was open took the whole page down with it. Reported from
   * 「コンポーネントの再生成」, a button inside that drawer — both since removed —
   * which appended a message: the run started correctly and the screen jumped.
   *
   * Setting `scrollTop` on the thread cannot move anything but the thread.
   *
   * Goes through the follower (utils/chat/stickToBottom) so that reaching the end
   * also means staying there while the run's card keeps growing.
   */
  const stickRef = useRef<StickToBottom | null>(null);
  const stuckToRef = useRef<HTMLDivElement | null>(null);
  /**
   * The follower for whatever element the thread currently IS.
   *
   * Rebuilt when the element changes rather than captured once: a follower
   * holding a node React has replaced scrolls a node nobody can see, and the
   * symptom is exactly the one reported — the chat simply stops following, with
   * no error anywhere.
   */
  const threadFollower = useCallback(() => {
    const el = chatThreadRef.current;
    if (!el) return null;
    if (!stickRef.current || stuckToRef.current !== el) {
      stickRef.current = createStickToBottom(el);
      stuckToRef.current = el;
    }
    return stickRef.current;
  }, []);
  const scrollChatToEnd = useCallback(() => {
    threadFollower()?.scrollToEnd(true);
  }, [threadFollower]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  // Wide enough for the composer's dropdown menus, whose option descriptions run
  // to a sentence; at 340 the 形式 menu was clipped by the pane edge.
  const [chatWidth, setChatWidth] = useState<number | null>(420);
  const [isResizing, setIsResizing] = useState(false);
  const { models } = useModels();
  /**
   * The models this user may actually pick.
   *
   * A filter over the list, not the enforcement — the pipeline applies the same
   * set itself, so a stale page or a hand-made request still gets clamped.
   * Offering a model the server will quietly replace is the thing to avoid: the
   * user chooses Opus, waits, and receives Sonnet without being told why.
   */
  const allowedModels = useMemo(() => {
    const permitted = usage?.allowedModels;
    if (!permitted || permitted.length === 0) return models;
    return models.filter((m: { id: string }) => {
      // A model the setting does not name is not something it governs.
      if (!['haiku', 'sonnet', 'opus', 'auto'].includes(m.id)) return true;
      return permitted.includes(m.id as 'haiku' | 'sonnet' | 'opus' | 'auto');
    });
  }, [models, usage?.allowedModels]);

  /**
   * A model that has just been withdrawn must not stay selected.
   *
   * Falling back to `auto` would be wrong precisely when it matters: `auto` is
   * itself something an administrator can withdraw, so a user restricted away
   * from it would be moved onto the one option they are not allowed. Preference
   * runs down from the most capable model they do have.
   */
  useEffect(() => {
    if (allowedModels.length === 0) return;
    if (allowedModels.some((m: { id: string }) => m.id === model)) return;
    const PREFERENCE = ['auto', 'opus', 'sonnet', 'haiku'];
    const best = PREFERENCE.find((id) => allowedModels.some((m: { id: string }) => m.id === id));
    if (best) setModel(best as 'auto' | 'haiku' | 'sonnet' | 'opus');
  }, [allowedModels, model]);
  // Reopening a project should keep the format it was last built in. The project
  // record does not store it, but the document itself is unambiguous: a React
  // project is source blocks, an HTML mock is not.
  /**
   * The framework a reopened project is written in, read from its own files.
   *
   * A stored project predates the field, and 34 of them are HTML — which is no
   * longer a choice. Those fall back to the default and show a build error
   * rather than pretending to be a project, which is the honest outcome for a
   * format the pipeline no longer produces.
   */
  const [outputKind, setOutputKind] = useState<OutputKind>(
    () => detectKind(splitHtmlToFiles(project.lastHtml ?? '')) ?? 'react'
  );
  /**
   * Whether the format shown is the document's, or the fallback.
   *
   * `detectKind` returns null for a document carrying no `.tsx`, `.vue` or
   * `.svelte` — an HTML-era mock, or anything the pipeline did not assemble.
   * The fallback then made it `react`, and the menu locked because a document
   * existed: a guess displayed as a fact, and then frozen. The next edit went
   * out as React over markup that is not React, which compiles far enough to
   * look like the model got worse.
   *
   * Locking is for keeping an edit consistent with the project it edits. There
   * is nothing to be consistent with when the format is unknown, so the menu
   * stays open and says why.
   */
  const [formatDetected, setFormatDetected] = useState(
    () => detectKind(splitHtmlToFiles(project.lastHtml ?? '')) !== null
  );
  /**
   * The same question again, once the document is actually here.
   *
   * This is now the ordinary path, and the initialiser above is the exception.
   * The project list no longer carries documents, so opening a project starts
   * with nothing to detect and `detectKind('')` falls back to `react` — a Svelte
   * project would reopen saying React and the next edit would be sent as React,
   * with nothing on screen to show it but the composer naming the wrong
   * framework.
   *
   * It was written for the projects too large to store inline, when it fired for
   * perhaps one in a hundred openings. Removing the inline copy made every
   * opening that case, which is the whole reason it had to exist first.
   *
   * `touchedFormatRef` keeps this from overruling a person: the recovery lands
   * about a second after the project opens, and choosing a format in that second
   * is a thing someone can do.
   */
  const touchedFormatRef = useRef(false);
  /**
   * Which document the format was read from, rather than whether it was read.
   *
   * A once-only flag was wrong for the same reason the preview fetch was: it
   * was set the first time any document arrived, including the stale copy
   * carried in from the project list — so a project reopened while the list
   * held a React snapshot of what is now a Vue project kept saying React, and
   * the next edit would have gone out in the wrong framework.
   *
   * Keyed on the document, the format follows whatever is actually on the
   * canvas: the replacement above, and a stored version selected from the
   * dropdown. `touchedFormatRef` still wins — a person's choice is not a guess
   * to be corrected a second later.
   */
  const derivedFormatFromRef = useRef<string | null>(null);
  useEffect(() => {
    if (touchedFormatRef.current || !loadedHtml) return;
    if (derivedFormatFromRef.current === loadedHtml) return;
    derivedFormatFromRef.current = loadedHtml;
    const kind = detectKind(splitHtmlToFiles(loadedHtml));
    if (kind) {
      setOutputKind(kind);
      setFormatDetected(true);
    }
  }, [loadedHtml]);
  /**
   * Plan mode proposes before it builds.
   *
   * A generation costs minutes, so the decisions worth arguing with — how many
   * screens, what the visual direction is, what actually has to work — are cheapest
   * to change before any code exists rather than after.
   */
  const [chatMode, setChatMode] = useState<'build' | 'plan'>('build');
  /**
   * How much the next build may spend.
   *
   * Kept apart from `chatMode` so that approving a plan returns to the effort the
   * user had chosen. Folding them into one value would mean an approved plan
   * always built at the default, quietly discarding a 思考 they had selected.
   */
  const [effort, setEffort] = useState<Effort>('checked');
  const menuMode = chatMode === 'plan' ? 'plan' : effort;
  /*
   * What the mode fixes, and what the composer therefore sends.
   *
   * `model` keeps the user's own choice untouched while a locking mode is
   * selected, so switching back to 構築 restores it rather than leaving them on
   * whatever the last mode ran — which is now simply the model, because no mode
   * substitutes one. Kept as a name rather than inlined: it is what gets sent
   * AND what gets persisted with the project, and those two being the same
   * value is the point.
   */
  const effectiveModel = model;
  const selectMode = (id: string) => {
    if (id === 'plan') { setChatMode('plan'); return; }
    setChatMode('build');
    setEffort(id as Effort);
  };

  const generatedHtml = modifiedHtml ?? result ?? loadedHtml;
  /**
   * Hand edits, layered over whatever the pipeline last produced.
   *
   * Reset on any new document — a generation, a chat edit, a version restored
   * from history — so an override can never quietly mask the thing the user just
   * asked for. The reset key is what identifies "a different document".
   */
  const directEdit = useDirectEdit({
    baseHtml: generatedHtml,
    projectId: project.projectId,
    preset,
    score: score ?? undefined,
    resetKey: `${project.projectId}|${selectedVersionId ?? ''}|${result?.length ?? 0}|${modifiedHtml?.length ?? 0}`,
    /* A hand edit is a version like any other, so the list has to hear about it
       — see the note in utils/projects/versionOptions.ts. */
    onSaved: () => fetchVersions(project.projectId),
  });
  const displayHtml = directEdit.edited ?? generatedHtml;

  /**
   * The selected element's own text, when it has nothing but text.
   *
   * Derived on every render rather than held in state. The document changes
   * under this — a model edit, a version switch — and a copy taken when the
   * element was clicked would be written back over a file that had moved on.
   */
  const anchoredText = (() => {
    const at = readAnchor(selectedAnchor);
    if (!at || !displayHtml) return null;
    const file = splitHtmlToFiles(displayHtml).find((f) => f.path === at.path);
    return file ? elementText(file.content, at.line) : null;
  })();

  const applyText = (text: string) => {
    const at = readAnchor(selectedAnchor);
    if (!at || !displayHtml) return;
    const file = splitHtmlToFiles(displayHtml).find((f) => f.path === at.path);
    if (!file) return;
    const next = setElementText(file.content, at.line, text);
    if (next === null) {
      setStructuralNote('この文字列は書き込めません（< や { は本文になりません）。');
      return;
    }
    if (!directEdit.editSource(at.path, next)) {
      setStructuralNote(`${at.path} には書き込めません。`);
      return;
    }
    setStructuralNote(null);
  };

  /**
   * The document to draw under a reply.
   *
   * `msg.html` is a whole document per message and is deliberately not stored,
   * so every reply lost its thumbnail on reopening the project — the second half
   * of 「プレビュー表示が消えています」.
   *
   * The newest reply's output is recoverable without storing anything: it is the
   * project's current document, which is exactly what that reply produced. Older
   * replies are not, and are left without rather than shown the current document
   * — a thumbnail under an earlier reply showing a later screen would be a
   * confident lie, where a missing one is only a gap. Their documents are in
   * version history.
   *
   * Suppressed while a stored version is on the canvas: `displayHtml` is then
   * that version rather than the reply's output.
   */
  const lastAssistantId = [...messages].reverse().find((m) => m.role === 'assistant')?.id;
  const thumbnailFor = (msg: ChatMessage): string | null =>
    msg.html ?? (msg.id === lastAssistantId && selectedVersionId === '' ? displayHtml : null);

  // Load chat messages from DynamoDB on mount
  const chatLoadedRef = useRef(false);
  /** The thread could not be read, so what is on screen is not the whole of it. */
  const [historyError, setHistoryError] = useState(false);
  useEffect(() => {
    if (chatLoadedRef.current) return;
    loadMessages(project.projectId).then((stored) => {
      /*
       * A failed read must not open the gate.
       *
       * `chatLoadedRef` is what allows saving, and it used to be set whatever
       * came back — while a failed read returned `[]`, indistinguishable from a
       * project with no messages. So a read that failed showed an empty thread,
       * and the next message saved a thread of one over the real one. Leaving
       * the gate shut costs this session's messages; opening it cost the
       * conversation.
       */
      if (stored === null) {
        setHistoryError(true);
        return;
      }
      chatLoadedRef.current = true;
      if (stored.length > 0) {
        /*
         * `html` is not stored — a whole document per reply — so it cannot come
         * back this way. The thumbnail for the newest reply is restored at the
         * render site instead, from the project's own document, which is what
         * that reply produced. Older replies keep their own documents in version
         * history and are not recovered here.
         */
        setMessages(stored.map((m) => ({ ...m, html: undefined, phases: readStoredPhases(m.phases) })));
      }
    });
  }, [project.projectId, loadMessages]);

  /**
   * Re-attach each reply's document after a reload.
   *
   * Chat history cannot carry the documents — a DynamoDB item caps at 400KB and a
   * single generated project already runs to 80KB — so the stored messages come
   * back with no `html`, and every reply lost its preview on reopen.
   *
   * Version history has the documents, and every generate and every modify writes
   * exactly one version. They are matched by time rather than by index: replies
   * that produced nothing (an error, a rejected edit, a plan proposal) have no
   * version, so positions do not line up, but timestamps still do.
   */
  const thumbsAttachedRef = useRef(false);
  // Keyed on both: the two fetches race, and versions usually win. Watching only
  // `versions` meant the effect ran once against an empty thread and never again.
  useEffect(() => {
    if (thumbsAttachedRef.current || versions.length === 0) return;
    setMessages((prev) => {
      if (prev.length === 0 || prev.some((m) => m.html)) return prev;
      thumbsAttachedRef.current = true;
      const pool = versions
        .map((v) => ({ at: new Date(v.createdAt).getTime(), html: v.html }))
        .filter((v) => v.html && !Number.isNaN(v.at));
      const taken = new Set<number>();
      let changed = false;
      const next = prev.map((m) => {
        if (m.role !== 'assistant') return m;
        let best = -1;
        let bestGap = Infinity;
        pool.forEach((v, i) => {
          if (taken.has(i)) return;
          const gap = Math.abs(v.at - m.timestamp);
          if (gap < bestGap) { bestGap = gap; best = i; }
        });
        // A reply and the version it wrote land within seconds of each other. A
        // wider window would attach an unrelated document to an error message.
        if (best === -1 || bestGap > 120_000) return m;
        taken.add(best);
        changed = true;
        return { ...m, html: pool[best].html };
      });
      return changed ? next : prev;
    });
  }, [versions, messages.length]);

  // Save chat messages to DynamoDB when they change (debounced in hook)
  const messagesLenRef = useRef(0);
  useEffect(() => {
    if (!chatLoadedRef.current) return;  // don't save before initial load completes
    // A viewer's copy of the thread is read-only; the server would refuse the save.
    if (readOnly) return;
    if (messages.length === messagesLenRef.current) return;
    messagesLenRef.current = messages.length;
    saveMessages(project.projectId, messages);
  }, [messages, project.projectId, saveMessages, readOnly]);

  // Add assistant message when generation completes
  useEffect(() => {
    if (result && !isGenerating) {
      setSelectedVersionId('');
      setMessages((prev) => {
        const lastAssistant = [...prev].reverse().find((m) => m.role === 'assistant');
        if (lastAssistant?.html === result) return prev;
        return [...prev, {
          id: crypto.randomUUID(),
          role: 'assistant',
          /*
            The model's own reasoning, and nothing appended to it.
            `UI generated (Score: 74/100)` was a second copy of what the meta row
            under the reply already shows, in English, in a Japanese thread, on
            a line of its own. The score has a chip that explains which scale it
            is on; the sentence had nowhere to say that.
          */
          content: plan || 'UIを生成しました。',
          html: result,
          score: score ?? undefined,
          tokenUsage: tokenUsage ?? undefined,
          // What actually ran, from the run itself. Falling back to the
          // composer's current values would record a guess: `auto` resolves to
          // a real tier server-side, and both controls can be changed between
          // starting a run and its reply arriving.
          runInfo: genRunInfo ?? undefined,
          phases: phases.length > 0 ? trimPhasesForStorage(phases) : undefined,
          timestamp: Date.now(),
        }];
      });
      // preset/model were never persisted, so reopening a project always fell
      // back to the defaults regardless of what it was built with.
      if (persistedHtmlRef.current !== result) {
        persistedHtmlRef.current = result;
        onUpdateProject(project.projectId, { lastHtml: result, preset, model });
      }
      /*
       * A project that was never named takes its name from what was built.
       *
       * Read out of the document rather than asked for — see utils/projects/projectTitle.
       * Both the stored name and the box in the header are checked: the box is
       * what the user is looking at, and renaming under a name they have typed
       * but not yet blurred would take it away as they were writing it.
       */
      if (isUnnamed(project.name) && isUnnamed(projectTitle)) {
        const named = titleFromResult(result, genPromptRef.current);
        if (named) {
          setProjectTitle(named);
          onUpdateProject(project.projectId, { name: named });
        }
      }
    }
  }, [result, isGenerating, score, plan, tokenUsage, genRunInfo, phases, onUpdateProject, project.projectId, project.name, projectTitle, preset, model]);

  // Add assistant message when modification completes
  useEffect(() => {
    if (modifiedHtml && !isModifying) {
      setSelectedVersionId('');
      const attemptedHtml = modifyAttemptHtmlRef.current;
      modifyAttemptHtmlRef.current = null;
      if (modifiedHtml === attemptedHtml) {
        setMessages((prev) => [...prev, {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: '変更を適用できませんでした。指示を変えて再度お試しください。',
          timestamp: Date.now(),
        }]);
      } else {
        setMessages((prev) => {
          const lastAssistant = [...prev].reverse().find((m) => m.role === 'assistant');
          if (lastAssistant?.html === modifiedHtml) return prev;
          return [...prev, {
            id: crypto.randomUUID(),
            role: 'assistant',
            // As above: the tools are already listed in the meta row, so the
            // reply is the model's account of the edit and nothing else.
            content: modifyPlan || '変更を適用しました。',
            html: modifiedHtml,
            toolsUsed: toolsUsed.length > 0 ? [...toolsUsed] : undefined,
            tokenUsage: modifyTokenUsage ?? undefined,
            runInfo: modifyRunInfo ?? undefined,
            phases: modifyPhases.length > 0 ? trimPhasesForStorage(modifyPhases) : undefined,
            timestamp: Date.now(),
          }];
        });
        // Only generation used to persist its output, so every edit was lost on
        // reopen and the project reverted to its pre-edit state.
        if (persistedHtmlRef.current !== modifiedHtml) {
          persistedHtmlRef.current = modifiedHtml;
          onUpdateProject(project.projectId, { lastHtml: modifiedHtml, preset, model });
        }
      }
    }
  }, [modifiedHtml, isModifying, toolsUsed, modifyPlan, modifyRunInfo, modifyTokenUsage, modifyPhases, onUpdateProject, project.projectId, preset, model]);

  // Add the proposal to the thread when plan mode finishes
  const planShownRef = useRef<string | null>(null);
  useEffect(() => {
    if (!planResult || isPlanning) return;
    const key = `${planResult.prompt}\u0000${planResult.plan.length}`;
    if (planShownRef.current === key) return;
    planShownRef.current = key;
    setMessages((prev) => [...prev, {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: planResult.plan,
      proposal: planResult,
      runInfo: planResult.runInfo,
      timestamp: Date.now(),
    }]);
  }, [planResult, isPlanning]);

  useEffect(() => {
    if (!planError) return;
    setMessages((prev) => [...prev, {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: planError,
      timestamp: Date.now(),
    }]);
  }, [planError]);

  // Add error assistant message when modification fails
  // Use a counter to force the effect to re-run even when the error string is identical
  const modifyErrorKeyRef = useRef(0);
  const [modifyErrorEntry, setModifyErrorEntry] = useState<{ msg: string; key: number } | null>(null);
  useEffect(() => {
    if (modifyError) {
      modifyErrorKeyRef.current += 1;
      setModifyErrorEntry({ msg: modifyError, key: modifyErrorKeyRef.current });
    }
  }, [modifyError]);
  useEffect(() => {
    if (!modifyErrorEntry) return;
    modifyAttemptHtmlRef.current = null;
    setMessages((prev) => [...prev, {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: modifyErrorEntry.msg,
      timestamp: Date.now(),
    }]);
  }, [modifyErrorEntry]);

  /**
   * Auto-scroll the thread.
   *
   * Deliberately NOT keyed on the streaming text: the reasoning log scrolls
   * inside its own fixed height, so the thread's height no longer changes while
   * tokens arrive. Chasing every token would fight the user for control of the
   * scroll position for the whole run, and it was never the reason the panel was
   * hard to read — the unbounded panel was.
   *
   * The phase is included so each new stage brings the card back into view.
   * Growth between those moments — a step's text arriving a poll after its
   * label — is followed by the thread follower, not by this list.
   */
  useEffect(() => {
    scrollChatToEnd();
  }, [messages, isGenerating, isModifying, isPlanning, streamPhase, modifyStreamPhase, scrollChatToEnd]);

  /**
   * Grow the composer with its content.
   *
   * A one-line box makes anything longer than a sentence unreviewable before it
   * is sent, and a brief worth writing is usually several lines. Height is reset
   * to auto first so the box shrinks again on delete, and capped so a long paste
   * cannot swallow the conversation.
   */
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [inputText]);

  /**
   * Follow the thread's content while the reader is at the end, and show the
   * scroll-to-bottom button when they are not.
   *
   * Sizes are watched on the thread's direct children — the messages and the
   * activity card — because the thread itself is the scroll container and its own
   * box never changes size. The set of children changes as messages arrive, so
   * it is re-observed on every child list change. ResizeObserver already
   * delivers at most once per frame, so a burst of growth is one callback.
   */
  useEffect(() => {
    const el = threadEl;
    const follower = threadFollower();
    if (!el || !follower) return;
    const handleScroll = () => {
      follower.onScroll();
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      setShowScrollBtn(distFromBottom > 100);
    };
    const handleScrollEnd = () => follower.onScrollEnd();
    const handleIntent = () => follower.onUserIntent();
    const sizes = new ResizeObserver(() => follower.contentChanged());
    const observeChildren = () => {
      sizes.disconnect();
      for (const child of Array.from(el.children)) sizes.observe(child);
    };
    observeChildren();
    const children = new MutationObserver(observeChildren);
    children.observe(el, { childList: true });
    el.addEventListener('scroll', handleScroll, { passive: true });
    el.addEventListener('scrollend', handleScrollEnd);
    el.addEventListener('wheel', handleIntent, { passive: true });
    el.addEventListener('touchstart', handleIntent, { passive: true });
    el.addEventListener('keydown', handleIntent);
    /**
     * A heartbeat, because the observers above are not guaranteed to fire.
     *
     * ResizeObserver and requestAnimationFrame are suspended while the tab is in
     * the background (measured — neither fires at all, not even the observer's
     * first callback), and the run keeps writing the whole time. A change that
     * lands while they are asleep is a thread that never catches up, because
     * nothing afterwards is a growth event.
     *
     * Half a second is far below noticing and costs one comparison when the
     * reader is already at the end, which is the common case. The reported
     * symptom was the chat not following a run at all, and a check that cannot
     * be starved is worth more here than the last word in elegance.
     */
    const heartbeat = window.setInterval(() => follower.contentChanged(), 500);
    const onVisible = () => follower.contentChanged();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(heartbeat);
      document.removeEventListener('visibilitychange', onVisible);
      sizes.disconnect();
      children.disconnect();
      el.removeEventListener('scroll', handleScroll);
      el.removeEventListener('scrollend', handleScrollEnd);
      el.removeEventListener('wheel', handleIntent);
      el.removeEventListener('touchstart', handleIntent);
      el.removeEventListener('keydown', handleIntent);
    };
  }, [threadEl, threadFollower]);

  // Resize handle logic — chat pane
  useEffect(() => {
    if (!isResizing) return;
    const handleMouseMove = (e: MouseEvent) => {
      const maxW = window.innerWidth - 400;
      const newWidth = Math.max(280, Math.min(e.clientX, maxW));
      setChatWidth(newWidth);
    };
    const handleMouseUp = () => setIsResizing(false);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);

  /**
   * Fetch version history for this project, and again whenever a run finishes.
   *
   * It used to be fetched on project open only. Every generate and every modify
   * writes a version, so the dropdown was missing the run the user had just
   * watched complete — the newest thing they could select was always the one
   * before it. `isGenerating`/`isModifying` falling to false is the moment the
   * server has written it.
   */
  useEffect(() => {
    if (isGenerating || isModifying) return;
    fetchVersions(project.projectId);
  }, [project.projectId, isGenerating, isModifying, fetchVersions]);

  const formatRelativeTime = (ts: number) => {
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60) return 'たった今';
    if (diff < 3600) return `${Math.floor(diff / 60)}分前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}時間前`;
    return `${Math.floor(diff / 86400)}日前`;
  };

  /**
   * Download the project as a zip.
   *
   * Replaces "Copy HTML", which was actively misleading for React output: the
   * clipboard received one transport document full of `data-file` blocks, which is
   * neither the HTML of anything nor a project anyone can open. The zip carries
   * exactly what the Code tab shows — the split sources plus the scaffold — so it
   * unpacks into a directory that runs.
   */
  const [zipState, setZipState] = useState<'idle' | 'done' | 'error'>('idle');

  const handleDownloadZip = () => {
    if (!displayHtml) return;
    try {
      const files = toProjectFiles(splitHtmlToFiles(displayHtml), projectTitle || 'MakeUI App');
      const blob = createZip(files.map((f) => ({ path: f.path, content: f.content })));
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = zipFileName(projectTitle || project.name);
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoked on a later tick: revoking synchronously can cancel the download
      // before the browser has read the blob.
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setZipState('done');
    } catch {
      setZipState('error');
    }
    setTimeout(() => setZipState('idle'), 2000);
  };

  const handleScrollToBottom = () => {
    scrollChatToEnd();
  };

  /**
   * Repair the document from a runtime error the preview caught.
   *
   * The frame already reports these — `reactRuntimeError` in Preview.tsx has
   * always been set from the iframe's own `postMessage` — and the panel showed
   * the message and stopped there. So the app KNEW the build did not start and
   * offered nothing to do about it.
   *
   * Which matters most in 下書き, where the pipeline runs no browser and no
   * repair at all: measured on the checked pipeline, 16 of 259 runs (6.2%)
   * carried a hard runtime failure that the browser caught and fixed. In 下書き
   * that share reaches the user, and this is the only thing that sees it.
   *
   * Sent as an ordinary edit, so it lands in the thread as one and is undoable
   * the same way. The message is the user's — they pressed the button — and
   * carries the error verbatim: the model needs the stack, and the person
   * reading the thread later needs to know why a repair happened.
   */
  const repairRuntimeError = (detail: string) => {
    if (!displayHtml || isProcessing) return;
    const instruction = runtimeRepairInstruction(detail);
    if (!instruction) return;
    setMessages((prev) => [...prev, {
      id: crypto.randomUUID(),
      role: 'user',
      content: runtimeRepairMessage(detail),
      timestamp: Date.now(),
    }]);
    modifyAttemptHtmlRef.current = displayHtml;
    // no-attachment: the button repairs a runtime error, not the user's next
    // message. Whatever image is staged in the composer belongs to the request
    // they are still writing; sending it here would spend it on a fix they did
    // not ask to attach it to, and leave the composer looking like it still had it.
    modify(displayHtml, instruction, preset, effectiveModel, undefined, project.projectId, undefined, effort, undefined);
  };

  const handleSend = () => {
    if (!inputText.trim()) return;
    const rawText = inputText.trim();
    // Refused here rather than by a 400 after the upload — see utils/requests/requestLimits.ts.
    const tooLong = promptProblem(rawText);
    if (tooLong) {
      setImageError(tooLong);
      setTimeout(() => setImageError(null), 6000);
      return;
    }
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: rawText,
      // Always recorded: a project shared later still says who asked what before.
      author: selfAuthor,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMessage]);

    if (chatMode === 'plan') {
      // Planning an edit is a different question from planning a build, and the
      // server tells them apart by whether a document came with the request.
      planPromptRef.current = rawText;
      // A plan for a rebuild is a plan for a build: the document is withheld so
      // the server asks the right question of it.
      // The plan REPLACES the design phase on build, so it takes the same
      // pictures the build would have had.
      {
        const picked = uiImagesForSend(image, extraImages);
        const forBuild = rebuilding || !displayHtml;
        // Answering a proposal amends it — see utils/chat/planRevision.ts.
        const revision = forBuild ? proposalBeingAnswered(messages) : undefined;
        proposePlan(rawText, preset, effectiveModel, outputKind, forBuild ? undefined : (displayHtml ?? undefined), picked.image, dataFile ?? undefined, picked.images, captionsForSend(picked, imageNotes), revision);
      }
    } else if (displayHtml && !rebuilding) {
      modifyAttemptHtmlRef.current = displayHtml;
      // Every picture and its description, as the build sends them — an edit used to
      // send the first and clear the rest.
      const pickedForEdit = uiImagesForSend(image, extraImages);
      modify(displayHtml, rawText, preset, effectiveModel, selectedSelector ?? undefined, project.projectId, pickedForEdit.image, effort, dataFile ?? undefined, pickedForEdit.images, captionsForSend(pickedForEdit, imageNotes));
      // Cleared like the generate branch: an attachment belongs to the message it
      // was sent with, and silently reapplying it to the next edit is worse than
      // never having sent it. The plan branch deliberately keeps it — the image is
      // still needed when the proposal is approved and built.
      setImage(null);
      setExtraImages([]);
      setImageNotes([]);
      setDataFile(null);
    } else {
      resetModify();
      setSelectedSelector(null); setSelectedAnchor(null);
      setLoadedHtml(null);
      // One picture is a reference, several are content. See utils/requests/uiImages.ts —
      // the rule lives there because it decides which field the request carries
      // and the finished UI is the only place it is visible afterwards.
      genPromptRef.current = rawText;
      const picked = uiImagesForSend(image, extraImages);
      /*
       * The descriptions travel with the pictures: aligned by index with a list,
       * or alone beside a single picture — whose description box used to be
       * typed into and dropped. See `captionsForSend`.
       */
      const notes = captionsForSend(picked, imageNotes);
      generate(
        rawText, preset, effectiveModel, picked.image,
        project.projectId, outputKind, undefined, effort, dataFile ?? undefined,
        picked.images, notes,
      );
      setImage(null);
      setExtraImages([]);
      setImageNotes([]);
      setDataFile(null);
    }
    setInputText('');
    setSelectedSelector(null); setSelectedAnchor(null);
  };

  /**
   * Ask for one open finding to be fixed, from the finding itself.
   *
   * The findings list was a list of things to read. Acting on one meant copying
   * it into the composer, and a person who has just been told 「スタイルが各
   * コンポーネントに散っていて、共通化されていません」 has to retype it to ask for
   * the obvious next thing.
   *
   * One finding per request, deliberately, and this is the pipeline's own
   * measurement rather than a UI preference: a repair call handed eight
   * unrelated instructions 「returned exactly as many defects as it was given」,
   * which is why the repair pass and the edit path are both one file at a time.
   * A 「まとめて修正」 button would be the shape that was measured failing.
   *
   * It sends rather than filling the composer, because the ask was one click.
   * The button is disabled while anything is running, so the click cannot queue.
   */
  const handleFixFinding = (finding: string) => {
    if (!displayHtml || rebuilding || isProcessing) return;
    const instruction = findingFixInstruction(finding);
    if (!instruction) return;
    setMessages((prev) => [...prev, {
      id: crypto.randomUUID(),
      role: 'user',
      content: findingFixMessage(finding),
      timestamp: Date.now(),
    }]);
    modifyAttemptHtmlRef.current = displayHtml;
    // no-attachment: the button acts on a finding about the document as it
    // stands. A picture staged in the composer belongs to the message the
    // person is still writing, and spending it on a fix they did not attach it
    // to would also leave the composer looking as though it still held one.
    modify(displayHtml, instruction, preset, effectiveModel, undefined, project.projectId, undefined, effort, undefined);
  };

  /**
   * Accept a proposal and build it.
   *
   * The specification travels with the approval, so the build starts at code
   * generation instead of designing the same brief a second time — which would
   * both cost the design phase twice and risk producing something other than what
   * was agreed.
   */
  const handleApprovePlan = (proposal: { plan: string; spec: string; prompt: string }) => {
    setMessages((prev) => [...prev, {
      id: crypto.randomUUID(),
      role: 'user',
      content: 'このプランで作成してください。',
      timestamp: Date.now(),
    }]);
    setChatMode('build');
    resetPlan();
    /* The same question as `handleSend`, and it has to be asked the same way: a
       proposal made for a rebuild was written without the document, so building
       it as an edit would apply a plan for a new project to the old one. */
    // The pictures the plan was written with, all of them — the approved build used to get the first.
    const pickedForBuild = uiImagesForSend(image, extraImages);
    const notesForBuild = captionsForSend(pickedForBuild, imageNotes);
    if (displayHtml && !rebuilding) {
      modifyAttemptHtmlRef.current = displayHtml;
      modify(displayHtml, proposal.prompt, preset, effectiveModel, undefined, project.projectId, pickedForBuild.image, effort, dataFile ?? undefined, pickedForBuild.images, notesForBuild);
    } else {
      resetModify();
      setLoadedHtml(null);
      generate(proposal.prompt, preset, effectiveModel, pickedForBuild.image, project.projectId, outputKind, proposal.spec || undefined, effort, dataFile ?? undefined, pickedForBuild.images, notesForBuild);
    }
    /*
     * Cleared here rather than in each branch.
     *
     * Plan mode is the one place an attachment must SURVIVE being sent — the
     * proposal is written from it and the build that follows needs it too — so
     * this handler is where it is finally consumed, whichever branch consumed
     * it. It used to be cleared in the generate branch only, which left an edit
     * approved from a plan holding the file and re-applying it to whatever the
     * user typed next.
     */
    setImage(null);
    setExtraImages([]);
    setImageNotes([]);
    setDataFile(null);
  };

  /** Detach from the running generation and note it in the thread. */
  const handleStop = () => {
    if (isGenerating) stopGenerate();
    if (isModifying) stopModify();
    if (isPlanning) stopPlan();
    setMessages((prev) => [...prev, {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '生成を停止しました。',
      timestamp: Date.now(),
    }]);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  /**
   * The next message starts a new document instead of editing this one.
   *
   * This was 「New Chat」, and it did three things behind one name: it cleared the
   * canvas, it unlocked the output format, and it emptied the message list —
   * which is persisted, so it deleted the conversation from the server. Only one
   * of those was in the name, and the destructive one was not.
   *
   * What it was actually reached for is the format. The 形式 menu locks while a
   * document exists, because an edit has to be written in the framework the
   * project is written in, and this was the only way past that lock.
   *
   * So it is that and nothing else now, and it destroys nothing to do it: a flag
   * saying the next send is a generation rather than an edit. The conversation
   * stays, the versions stay, the document stays on screen until the new one
   * replaces it, and pressing the chip again puts it back.
   */
  /**
   * The format of the document currently on screen, or null when it says nothing.
   *
   * Memoised on the document: `detectKind` reads the file list out of it, and a
   * project is up to 300,000 bytes.
   */
  const documentKind = useMemo(
    () => (displayHtml ? detectKind(splitHtmlToFiles(displayHtml)) : null),
    [displayHtml]
  );
  /**
   * Choosing a different format IS the request to rebuild.
   *
   * There used to be a 「形式を変更」 chip for this, and it existed because the
   * 形式 menu locks while a document exists — an edit has to be written in the
   * framework the project is written in. So changing the format took two
   * actions: arm the chip, then change the menu.
   *
   * The chip was never a separate decision. Nobody arms it and then leaves the
   * format alone, and nobody wants a React project edited as Svelte. The menu is
   * open now, and picking something the document is not is read as what it plainly
   * means: build the next message as a new document in that format.
   *
   * Derived rather than stored, so it cannot fall out of step with the menu. It
   * clears itself when the new document arrives and its format is detected back
   * into `outputKind`.
   */
  const rebuilding = Boolean(displayHtml) && documentKind !== null && outputKind !== documentKind;

  /**
   * Show a stored version on the canvas, leaving the conversation alone.
   *
   * This used to rebuild the thread from the version records. Those carry only the
   * prompt and the score, so every reply collapsed to "UI generated" and the
   * model's actual reasoning — the part worth reading — was destroyed, permanently
   * and with no undo. Looking at an earlier version is not an edit to the
   * conversation, so it no longer behaves like one.
   */
  const handleLoadVersion = (html: string) => {
    reset();
    resetModify();
    setSelectedSelector(null); setSelectedAnchor(null);
    setLoadedHtml(html);
  };

  /**
   * Switch the canvas to a stored version, or back to the live one.
   *
   * The document is fetched here rather than read off the dropdown's entry.
   * `GET /versions` returns metadata only — the bodies live in S3 and would make
   * listing them cost one download per row — so `entry.html` is always empty.
   * Reading it blanked the preview and the code pane on every switch.
   *
   * A copy of the live document used to be kept here, for the 「現在の状態」 row
   * to return to without a fetch. That row is gone: the live document is the
   * newest version, so returning to it is selecting a version like any other,
   * and the menu can no longer produce the empty id the branch existed to
   * handle.
   */
  const [versionLoading, setVersionLoading] = useState(false);

  const handleVersionSelect = async (versionId: string) => {
    const previous = selectedVersionId;
    setSelectedVersionId(versionId);

    if (!versions.some((v) => v.versionId === versionId)) return;

    setVersionLoading(true);
    try {
      const full = await loadVersion(versionId, project.projectId);
      // A failed fetch must leave the canvas alone: showing the previous document
      // is wrong, but blanking it is worse and looks like data loss.
      if (full?.html) handleLoadVersion(full.html);
      else setSelectedVersionId(previous);
    } finally {
      setVersionLoading(false);
    }
  };

  // Persist the in-flight job so leaving the project and coming back can
  // re-attach to it — the work continues server-side regardless.
  useEffect(() => {
    if (generateJobId && isGenerating) {
      setActiveJob(project.projectId, generateJobId, 'generate', { preset, model, outputKind });
    }
  }, [generateJobId, isGenerating, project.projectId, preset, model, outputKind]);

  useEffect(() => {
    if (modifyJobId && isModifying) {
      setActiveJob(project.projectId, modifyJobId, 'modify', { preset, model, outputKind });
    }
  }, [modifyJobId, isModifying, project.projectId, preset, model, outputKind]);

  // The design phase behind a plan runs for minutes, so a plan is worth
  // re-attaching to for exactly the same reason a generation is.
  const planPromptRef = useRef('');
  useEffect(() => {
    if (planJobId && isPlanning) {
      setActiveJob(project.projectId, planJobId, 'plan', { preset, model, outputKind, prompt: planPromptRef.current });
    }
  }, [planJobId, isPlanning, project.projectId, preset, model, outputKind]);

  /**
   * Opening a project shows the document the SERVER has, not a copy of it.
   *
   * This used to fetch only when there was nothing to render — `if (loadedHtml
   * || isGenerating) return` — which made `project.lastHtml`, the copy carried
   * in from the project list, authoritative whenever it happened to be set.
   * It is not authoritative and cannot be: it is written into the list's state
   * by `onUpdateProject` while the browser is watching a run, and by nothing
   * else. So:
   *
   *   generate → the list's copy is doc1 · start an edit · go back to the list
   *   → this component unmounts and the polling stops · the edit finishes
   *   server-side → the project row and version history hold doc2 · reopen
   *   → the canvas shows doc1 and the version dropdown shows v2
   *
   * Reported as exactly that: 「プレビューのバージョンとバージョンタブのバージョン
   * がずれている」. Nothing on screen could disagree with itself more directly —
   * the dropdown falls back to `versions[0]`, which IS the newest, so the two
   * halves were reading different sources for the same question.
   *
   * The server is the one source. `GET /projects/:id/preview` answers with the
   * project's own document, falling back to the newest version when the row has
   * none, so it is the same document the dropdown's first row names.
   *
   * The carried-in copy is still used, as the first paint — it is usually right
   * and it is instant — and it is REPLACED when the fetch disagrees with it.
   */
  const previewFetchedRef = useRef<string | null>(null);
  useEffect(() => {
    // Not while a run is in flight: it legitimately has no document yet, and
    // fetching would fight it. The effect runs again when the run ends.
    if (isGenerating) return;
    // Once per project: a project that genuinely has no document must not turn
    // into a request on every render.
    if (previewFetchedRef.current === project.projectId) return;
    previewFetchedRef.current = project.projectId;
    let cancelled = false;
    /** The copy this component opened with, and the only thing it may replace. */
    const carriedIn = project.lastHtml ?? null;
    fetchProjectPreview(project.projectId).then((html) => {
      if (cancelled || !html) return;
      setLoadedHtml((prev) => {
        /*
         * Anything but the carried-in copy is newer than this answer: output
         * produced since mount, or a stored version the person chose while the
         * request was in flight. Neither may be clobbered.
         */
        if (prev !== null && prev !== carriedIn) return prev;
        return html;
      });
    });
    return () => { cancelled = true; };
  }, [project.projectId, project.lastHtml, isGenerating, fetchProjectPreview]);

  /*
   * The transcript of the run in flight, kept beside its job record.
   *
   * `phases` is built in the browser by watching the server's single
   * `streamPhase` change between polls — the server keeps no history of it — so
   * it lives in a hook and nowhere else. Leaving the project threw it away and
   * coming back rebuilt it from whichever step was running, which is why the
   * progress display came back with most of itself missing.
   *
   * Trimmed with the same helper the chat history uses: a step's `text` is a
   * 6,000-character tail and there is no reason for storage to hold all of it.
   * Written only while something is running, so a finished run's last state is
   * not left behind to be resumed into the next one.
   */
  const liveP = isGenerating ? phases : isModifying ? modifyPhases : isPlanning ? planPhases : null;
  useEffect(() => {
    if (!liveP) return;
    setActivePhases(project.projectId, trimPhasesForStorage(liveP));
  }, [liveP, project.projectId]);

  // Re-attach before anything can clear the record: on a fresh mount both hooks
  // report idle, so an unguarded cleanup effect would wipe the very job we came
  // back to watch.
  const resumedRef = useRef<string | null>(null);
  useEffect(() => {
    if (resumedRef.current === project.projectId) return;
    resumedRef.current = project.projectId;
    const active = getActiveJob(project.projectId);
    if (!active) return;
    // Restore the chips to what the running job was actually started with, not to
    // the last completed run's values held on the project record.
    if (active.settings) {
      setPreset(normalizePreset(active.settings.preset));
      if (['auto', 'haiku', 'sonnet', 'opus'].includes(active.settings.model)) setModel(active.settings.model);
      if (isOutputKind(active.settings.outputKind)) {
        setOutputKind(active.settings.outputKind);
      }
    }
    // The steps already watched, so the transcript continues rather than
    // restarting at whichever one happens to be running now.
    const prior = readStoredPhases(getActivePhases(project.projectId));
    if (active.kind === 'generate') resumeGenerate(active.jobId, prior);
    else if (active.kind === 'plan') {
      setChatMode('plan');
      planPromptRef.current = active.settings?.prompt ?? '';
      resumePlan(active.jobId, planPromptRef.current, prior);
    } else resumeModify(active.jobId, prior);
  }, [project.projectId, resumeGenerate, resumeModify, resumePlan]);

  /**
   * Only this mount's own run may clear the record — a jobId exists exactly when
   * this component started or resumed one.
   *
   * And only a run that actually ended. When the client merely stops waiting the
   * job is still running, and clearing the record here is what made that
   * unrecoverable: the generation finished server-side with nothing left
   * pointing at it. Keeping the record is what lets reopening the project
   * re-attach and collect the result.
   */
  useEffect(() => {
    const owns = generateJobId || modifyJobId || planJobId;
    if (owns && !isGenerating && !isModifying && !isPlanning && !genAbandoned) {
      clearActiveJob(project.projectId);
    }
  }, [generateJobId, modifyJobId, planJobId, isGenerating, isModifying, isPlanning, genAbandoned, project.projectId]);

  const isProcessing = isGenerating || isModifying || isPlanning;

  /*
   * One paperclip, both kinds of attachment — and one definition, rendered
   * wherever attaching is possible.
   *
   * There were two buttons, because the two mean different things downstream
   * and still do: an image is a reference the design phase looks at, a data
   * file is what the screens are populated from — the reason a generated list
   * can stop being twelve identical invented rows. But that is a distinction
   * the pipeline needs, not one the person attaching a file should have to
   * make, and the cost of getting it wrong was a file silently refused by one
   * button that the other would have taken.
   *
   * The extension decides the route. Both slots survive, so attaching a
   * screenshot and then a CSV still sends both.
   *
   * Held in a name rather than written inline in the composer row because the
   * handler under it is a hundred lines of file reading, and a control is easier
   * to find when the row it sits in fits on a screen.
   */
  const attachControl = (
    <label className="app__attach-btn" aria-label="ファイルを添付">
      <input
        type="file"
        accept={ANY_ATTACHMENT_ACCEPT}
        multiple
        className="sr-only"
        onChange={(e) => {
          const el = e.target as HTMLInputElement;
          const picked = Array.from(el.files ?? []);
          const file = picked[0];
          if (!file) return;

          if (isImageAttachment(file.name)) {
            /*
             * Every image in this selection, and every one already
             * attached, counted against one ceiling.
             *
             * The bound is the backend's: it accepts eight and drops
             * the rest, so refusing the ninth here is the difference
             * between "you can attach eight" and a silent loss the
             * user only notices in the finished UI.
             */
            const tooLarge = oversizedImages(picked.filter((f) => isImageAttachment(f.name)));
            const images = picked.filter((f) => isImageAttachment(f.name) && !tooLarge.includes(f));
            if (tooLarge.length > 0) {
              // The API refuses a picture over 5MB; saying so now keeps the others.
              setImageError(`画像は1枚${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MBまでです（${tooLarge.map((f) => f.name).join('、')} は追加されませんでした）`);
              setTimeout(() => setImageError(null), 6000);
              if (images.length === 0) { el.value = ''; return; }
            }
            const room = roomForImages(image, extraImages);
            if (room <= 0) {
              el.value = '';
              setImageError(`画像は${MAX_UI_IMAGES}枚までです`);
              setTimeout(() => setImageError(null), 4000);
              return;
            }
            const taking = images.slice(0, room);
            const refused = images.length - taking.length;
            Promise.all(taking.map((f) => new Promise<string | null>((resolve) => {
              const r = new FileReader();
              r.onload = () => resolve(r.result as string);
              r.onerror = () => resolve(null);
              r.readAsDataURL(f);
            }))).then((read) => {
              el.value = '';
              const usable = read.filter((d): d is string => Boolean(d));
              if (usable.length === 0) {
                setImageError('画像の読み込みに失敗しました');
                setTimeout(() => setImageError(null), 3000);
                return;
              }
              // The first slot fills first, so attaching a single
              // picture behaves exactly as it always has.
              const rest = [...usable];
              if (!image) setImage(rest.shift() as string);
              if (rest.length > 0) setExtraImages((prev) => [...prev, ...rest]);
              const failed = read.length - usable.length;
              if (refused > 0 || failed > 0) {
                setImageError(
                  refused > 0
                    ? `画像は${MAX_UI_IMAGES}枚までです（${refused}枚は追加されませんでした）`
                    : `${failed}枚の画像を読み込めませんでした`
                );
                setTimeout(() => setImageError(null), 4000);
              }
            });
            return;
          }
          /*
           * Held in proportion to what it says. Four seconds was set
           * when the only message was 「画像の読み込みに失敗しました」;
           * the one for a PDF with no text layer names a cause and a
           * way round it, and vanishing mid-sentence would make it
           * worse than not saying it.
           */
          const showError = (msg: string) => {
            el.value = '';
            setImageError(msg);
            setTimeout(() => setImageError(null), Math.min(12_000, 3_000 + msg.length * 90));
          };
          const problem = attachmentProblem(file.name, file.size);
          if (problem) { showError(problem); return; }
          const reader = new FileReader();
          /*
           * A PDF is read as bytes and sent as the text it yielded.
           * Everything downstream — the payload, the API, the
           * sampling — is unchanged, because by the time it leaves
           * this handler it IS a text attachment. The filename keeps
           * the .pdf so the prompt can still say where it came from.
           */
          if (isPdf(file.name)) {
            setPdfReading(true);
            reader.onload = async () => {
              const bytes = new Uint8Array(reader.result as ArrayBuffer);
              const out = await extractPdfText(bytes);
              setPdfReading(false);
              if (out.problem) { showError(out.problem); return; }
              setDataFile({ name: file.name, content: out.text, pages: out.pages });
            };
            reader.onerror = () => { setPdfReading(false); showError('ファイルの読み込みに失敗しました'); };
            reader.readAsArrayBuffer(file);
            return;
          }
          reader.onload = () => {
            const content = String(reader.result ?? '');
            // Checked again after decoding: the size test above is
            // in bytes, and a Japanese CSV is three bytes a
            // character — so a file that passed can still be over.
            if (content.length > MAX_ATTACHMENT_CHARS) {
              showError(`ファイルが大きすぎます（${Math.round(MAX_ATTACHMENT_CHARS / 1000)}KB まで）。`);
              return;
            }
            if (!content.trim()) { showError('ファイルが空です。'); return; }
            setDataFile({ name: file.name, content });
          };
          reader.onerror = () => showError('ファイルの読み込みに失敗しました');
          reader.readAsText(file);
        }}
      />
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
      </svg>
    </label>
  );

  /*
   * The four menus on the composer bar.
   *
   * `placement="up"` because the bar sits at the bottom of the pane; a menu
   * dropping down from there would open off the bottom of the window.
   */
  const composerSettings = (
    <>
        <Dropdown
          placement="up"
          label="モード"
          value={menuMode}
          onChange={selectMode}
          disabled={isProcessing}
          options={CHAT_MODES}
        />
        {/*
          Always open. This used to lock whenever the mode fixed a
          model, which was three modes out of four — so the picker
          spent most of its life disabled, displaying a choice
          somebody else had made.
        */}
        <Dropdown
          placement="up"
          label="モデル"
          value={effectiveModel}
          onChange={(id) => setModel(id as 'auto' | 'haiku' | 'sonnet' | 'opus')}
          /*
            Never locked by the mode. Three of the four modes used to
            disable this control and substitute their own model — see
            the note where that table stood. The mode decides how much
            checking runs; this decides the model; neither overrides
            the other.
          */
          disabled={isProcessing}
          options={allowedModels.map((m) => ({
            id: m.id,
            label: m.label,
            badge: m.version ?? undefined,
            description: MODEL_NOTES[m.id],
          }))}
        />
        <Dropdown
          placement="up"
          label="デザイン"
          value={preset}
          onChange={setPreset}
          disabled={isProcessing}
          options={PRESETS.map((p) => ({ id: p.id, label: p.label, description: p.description }))}
        />
        <Dropdown
          placement="up"
          label="形式"
          value={outputKind}
          onChange={(id) => { touchedFormatRef.current = true; setOutputKind(id as OutputKind); }}
          disabled={isProcessing}
          title={
            rebuilding
              ? '次に送るメッセージから、この形式で新しく作り直します。会話とバージョン履歴はそのまま残ります'
              : displayHtml && formatDetected
                ? 'この文書の形式です。別の形式を選ぶと、次のメッセージは編集ではなく新しい文書の生成になります'
                : displayHtml
                  ? 'この文書の形式は判別できませんでした。編集を送る形式を選んでください'
                  : undefined
          }
          options={OUTPUT_KINDS}
        />
    </>
  );

  return (
    <div className={`app${isResizing ? ' app--resizing' : ''}`}>
      <header className="app__header">
        <div className="app__header-left">
          <button className="app__logo" onClick={onBackToProjects} type="button" title="プロジェクト一覧に戻る">MakeUI</button>
          <span className="app__header-sep">/</span>
          <input
            className="app__project-title"
            /*
             * Sized from the value, because an <input> will not do it itself.
             *
             * A Japanese character is about one em at this size and a Latin one
             * about half, so the two are counted separately rather than by
             * `length` — 「さくら歯科クリニック予約システム」 and "Inventory Manager"
             * are both sixteen characters and need very different widths. The
             * floor and ceiling are in the stylesheet, where the layout fact
             * that the header actions need room belongs.
             */
            style={{ width: `${titleWidthEm(projectTitle)}em` }}
            title={projectTitle}
            value={projectTitle}
            onChange={(e) => setProjectTitle(e.target.value)}
            onBlur={() => {
              if (!readOnly && projectTitle !== project.name) {
                onUpdateProject(project.projectId, { name: projectTitle });
              }
            }}
            // Renaming is a change to the project, which a viewer may not make.
            readOnly={readOnly}
            aria-label="プロジェクト名"
          />
        </div>
        <div className="app__header-actions">
          {displayHtml && (
            <button
              className="app__header-btn app__header-btn--primary"
              onClick={handleDownloadZip}
              type="button"
              title="プロジェクト一式をZIPでダウンロードします"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              {zipState === 'done' ? 'ダウンロードしました' : zipState === 'error' ? '失敗しました' : 'ZIPでダウンロード'}
            </button>
          )}
          {/*
            Publishing sits beside the export rather than at the bottom of a
            settings drawer: both are ways of taking the finished project out,
            and only one of them was findable.
          */}
          {/*
            Always there: sharing with people needs no screen yet, only the
            public link does, and the panel says so.
          */}
          <ShareButton html={displayHtml ?? null} title={projectTitle} projectId={project.projectId} role={project.access?.role ?? 'owner'} />
        </div>
        <div className="app__user">
          {/*
            No project list is fetched for this any more. The panel shows the
            monthly ledger alone, which the workspace already holds.
          */}
          <UsageMenu
            /*
              The server's answer, and nothing before it arrives.
              
              The local part used to stand in from the first frame, so an account
              whose stored name is not its address flashed the address's local
              part and then replaced it — visible on every load. The fallback is
              for an account with NO stored name, which is a state only the
              server can report; until it has, there is no name to show and a
              placeholder holds the space. See utils/account/displayName.ts.
            */
            name={usage?.displayName || (usageAnswered ? localPartOf(userEmail) : '')}
            group={usage?.group}
            limits={
              usage && {
                tokensUsed: usage.tokensUsed,
                tokensLimit: usage.tokensLimit,
                requestsUsed: usage.requestsUsed,
                cost: usage.cost,
                costEstimated: usage.costEstimated,
                groupBudget: usage.groupBudget,
              }
            }
            onOpen={refreshUsage}
          />
          {isAdmin && <AdminPanel />}
          <button onClick={logout} className="app__header-btn app__logout" aria-label="ログアウト" type="button">
            Logout
          </button>
        </div>
      </header>
      <div className="app__body" style={{ gridTemplateColumns: `${chatWidth ?? 420}px 1fr` }}>
        {/* Left: Chat */}
        <div className="app__chat-pane">
          <div
            className="app__chat-thread"
            ref={setChatThread}
            role="log"
            aria-label="会話履歴"
          >
            {messages.length === 0 && !isProcessing && (
              <div className="app__chat-empty">
                <h2 className="app__chat-empty-title">何を作りますか？</h2>
                <p>UIを説明するか、下のテンプレートを選んでください</p>
                <div className="app__suggest-prompts">
                  {/*
                    The chip shows the label and inserts the whole brief. It used
                    to insert its own label — 'ECサイトのトップページ' — which is a
                    five-word prompt, and the pipeline produces from a flat brief
                    exactly the flat page it describes.

                    The composer is focused afterwards so the inserted brief can
                    be edited before sending: it is a starting point, and landing
                    in a filled-but-unfocused textarea reads as a committed choice.
                  */}
                  {CHAT_SUGGESTIONS.map((template) => (
                    <button
                      key={template.id}
                      className="app__suggest-btn"
                      onClick={() => {
                        setInputText(template.prompt);
                        inputRef.current?.focus();
                      }}
                      type="button"
                      title={template.summary}
                      aria-label={`テンプレートを入力: ${template.label}`}
                    >
                      {template.label}
                    </button>
                  ))}
                </div>
                {/*
                  The other ten.
                  
                  The full list was a section of the settings drawer, which is a
                  place you go when you already know what you want — and a prompt
                  template is for when you do not. Six of the sixteen were already
                  here as chips; the rest are one disclosure below them, in the
                  one state where an empty composer is the thing being looked at.
                */}
                <PromptTemplates onSelect={(t) => { setInputText(t); inputRef.current?.focus(); }} />
              </div>
            )}
            {messages.map((msg) => (
              <div key={msg.id} className={`app__chat-msg app__chat-msg--${msg.role}${msg.timestamp >= openedAt ? ' app__chat-msg--new' : ''}`}>
                {msg.role === 'assistant' && (
                  <span className="app__chat-avatar" aria-hidden="true">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 2l1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9z" />
                    </svg>
                  </span>
                )}
                <div className="app__chat-msg-body">
                  {isSharedProject && msg.role === 'user' && msg.author?.name && (
                    <span className="app__message-author">{msg.author.name}</span>
                  )}
                  <div className="app__chat-msg-content">
                    {msg.role === 'assistant'
                      ? formatReply(msg.content).map((block, i) =>
                          block.kind === 'findings' ? (
                            /*
                              Folded, with the count showing.

                              After a first generation these were a paragraph of
                              bullets under the description — eight on the
                              verification run — so what the person asked for sat
                              above a wall of review notes. Worth having, not
                              worth reading first. A <details> rather than state:
                              it opens and closes from the keyboard, is announced
                              as expandable, and costs nothing to render closed.
                            */
                            <details className="app__findings" key={i}>
                              <summary className="app__findings-summary">
                                未解決の指摘 {block.count}件
                              </summary>
                              <ul className="app__chat-list app__findings-list">
                                {block.items.map((item, j) => (
                                  <li key={j}>
                                    <span className="app__findings-text">{renderInline(item)}</span>
                                    {/*
                                      One finding, one request. The button acts
                                      on the CURRENT document, which is what
                                      typing the same sentence would do — so a
                                      finding read out of an older reply still
                                      asks about what is on screen now.
                                    */}
                                    <button
                                      type="button"
                                      className="app__findings-fix"
                                      onClick={() => handleFixFinding(item)}
                                      disabled={!displayHtml || rebuilding || isProcessing}
                                      title="この指摘の修正を依頼します"
                                    >
                                      修正を依頼
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            </details>
                          ) : block.kind === 'opinions' ? (
                            /*
                              The critic's opinions the run does not repair — see
                              ReplyBlock 'opinions'. Folded like the findings and
                              with no fix button: measured, an edit does not move
                              these, and a button would offer one that does not.
                              They can still be asked for in words.
                            */
                            <details className="app__findings app__findings--opinions" key={i}>
                              <summary className="app__findings-summary">
                                デザインについての参考意見 {block.count}件
                              </summary>
                              <p className="app__findings-note">
                                画面の見た目についての批評です。自動修正では改善しにくいことが分かっているため、未解決の指摘には含めていません。気になるものは、具体的に指示すると反映できます。
                              </p>
                              <ul className="app__chat-list app__findings-list">
                                {block.items.map((item, j) => (
                                  <li key={j}>
                                    <span className="app__findings-text">{renderInline(item)}</span>
                                  </li>
                                ))}
                              </ul>
                            </details>
                          ) : block.kind === 'list' ? (
                            <ul className="app__chat-list" key={i}>
                              {block.items.map((item, j) => (
                                <li key={j}>{renderInline(item)}</li>
                              ))}
                            </ul>
                          ) : (
                            <p className="app__chat-para" key={i}>
                              {block.lines.map((line, j) => (
                                <span className="app__chat-line" key={j}>{renderInline(line)}</span>
                              ))}
                            </p>
                          )
                        )
                      : msg.content}
                  </div>
                  {msg.proposal && (
                    <div className="app__proposal-actions">
                      <button
                        className="app__proposal-btn app__proposal-btn--primary"
                        onClick={() => handleApprovePlan(msg.proposal!)}
                        disabled={isProcessing}
                        type="button"
                      >
                        このプランで作成
                      </button>
                      <span className="app__proposal-hint">
                        変更したい点があれば、そのまま入力してください
                      </span>
                    </div>
                  )}
                  {/*
                    Rendered through ProjectThumbnail rather than a raw iframe.
                    The raw frame used sandbox="" — no scripts — which paints blank
                    for everything this app produces: an HTML mock hides every screen
                    behind `.screen{display:none}` until its router runs, and a React
                    project is source blocks around an empty <div id="root">. So the
                    preview under each reply was blank in every case.
                  */}
                  {msg.role === 'assistant' && thumbnailFor(msg) && (
                    <div className="app__chat-thumbnail">
                      <ProjectThumbnail html={thumbnailFor(msg)} title="プレビューサムネイル" />
                    </div>
                  )}
                  {/*
                    The run that produced this reply, kept.
                    Closed by default — the reply is the answer and the
                    transcript is the working — and `<details>` rather than
                    component state so it survives re-renders and prints.
                  */}
                  {msg.phases && msg.phases.length > 0 && (
                    <details className="app__chat-transcript">
                      <summary className="app__chat-transcript-summary">
                        生成過程を表示
                        <span className="app__chat-transcript-count">{msg.phases.length}ステップ</span>
                      </summary>
                      <ReasoningTranscript phases={msg.phases} isActive={false} dense />
                    </details>
                  )}
                  <div className="app__chat-meta">
                    {/*
                      What produced this reply. The tier is the one that ran, so
                      a thread built with `auto` reads "Opus" rather than "自動"
                      — which is the question this answers.
                    */}
                    {msg.runInfo && (
                      <span
                        className="app__chat-run"
                        title={`このUIを生成したモデル: ${MODEL_LABELS[msg.runInfo.modelTier] ?? msg.runInfo.modelTier} / デザインプリセット: ${presetFullLabel(msg.runInfo.preset)}${effortLabel(msg.runInfo.effort) ? ` / モード: ${effortFullLabel(msg.runInfo.effort)}` : ''}`}
                      >
                        {MODEL_LABELS[msg.runInfo.modelTier] ?? msg.runInfo.modelTier}
                        <span className="app__chat-run-sep" aria-hidden="true">·</span>
                        {presetChip(msg.runInfo.preset)}
                        {/* Only when it is not the default: a chip on every reply
                            saying 「構築」 is noise, and the thing worth noticing is
                            that this one build was cheaper or dearer than usual. */}
                        {effortLabel(msg.runInfo.effort) && (
                          <>
                            <span className="app__chat-run-sep" aria-hidden="true">·</span>
                            {effortLabel(msg.runInfo.effort)}
                          </>
                        )}
                      </span>
                    )}
                    {/*
                      A score from a build that never rendered is not on the same
                      scale as one that did: every runtime deduction — dead
                      controls, empty containers, unreachable screens, contrast —
                      is unreachable without browser facts. Measured on one brief,
                      下書き scored 76 against 仕上げ's 52, and the unchecked one
                      was not better, it was unexamined. The mark says which
                      scale it is.
                    */}
                    {msg.score && (
                      <span
                        className="app__chat-score"
                        title={scoreTitle(msg.runInfo)}
                      >
                        Score {msg.score}
                        {msg.runInfo && msg.runInfo.scoreVerified === false && (
                          <span className="app__chat-score-unverified"> 静的のみ</span>
                        )}
                        {msg.runInfo && msg.runInfo.scoreVerified !== false && isOlderRubric(msg.runInfo.scoreParts?.rubric) && (
                          <span className="app__chat-score-unverified"> 旧基準</span>
                        )}
                      </span>
                    )}
                    {/*
                      No 「未修正」 count beside the score, and the reason is that
                      it answered a different question from the one next to it.

                      `unrepairedDefects` counts what the repair budget declined
                      to spend a call on. 「未解決の指摘」 in the reply counts what
                      was still open when the run ended. A defect can be in both,
                      in either, or in neither — a finding the budget skipped may
                      be fixed by another file's repair, and one it did spend a
                      call on may still be open. So two numbers sat a centimetre
                      apart, both labelled as things that were not fixed, and
                      disagreed. Reported by the user as exactly that.

                      The reply's count is the one that answers what a person is
                      asking, because it is the list they can act on — and every
                      item in it now has a button. The budget figure stays in the
                      job metadata and in the log, where the measurement lives.
                    */}
                    {msg.toolsUsed && msg.toolsUsed.length > 0 && (
                      <span className="app__chat-tools">{msg.toolsUsed.join(', ')}</span>
                    )}
                    {msg.tokenUsage && (
                      <span className="app__chat-tokens">
                        {(msg.tokenUsage.inputTokens + msg.tokenUsage.outputTokens).toLocaleString()} tokens
                      </span>
                    )}
                    <span className="app__chat-timestamp">{formatRelativeTime(msg.timestamp)}</span>
                  </div>
                </div>
              </div>
            ))}
            {/*
              Said in the thread, where the missing messages would have been.
              An empty conversation and an unreadable one look identical, and
              only one of them means the history is still there.
            */}
            {historyError && (
              <div className="app__chat-notice" role="status">
                これまでのやりとりを読み込めませんでした。履歴は残っています。
                このまま続けると、いまのやりとりは保存されません。
              </div>
            )}
            {saveFailed && (
              <div className="app__chat-notice app__chat-notice--warn" role="alert">
                やりとりを保存できていません。このタブを閉じると、ここでの会話は失われます。
              </div>
            )}
            {isGenerating && (
              <ActivityCard title="UIを生成しています" phases={phases} isActive={isGenerating} />
            )}
            {isModifying && (
              <ActivityCard title="変更を適用しています" phases={modifyPhases} isActive={isModifying} />
            )}
            {isPlanning && (
              <ActivityCard title="構成を検討しています" phases={planPhases} isActive={isPlanning} />
            )}
            {error && (
              <div className="app__chat-msg app__chat-msg--error" role="alert">
                {error}
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          {showScrollBtn && (
            <button
              className="app__scroll-bottom"
              onClick={handleScrollToBottom}
              aria-label="最新メッセージへ"
              type="button"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 16l-6-6h12z" />
              </svg>
            </button>
          )}

          {/* Chat Input */}
          {readOnly ? (
            /*
              A viewer's project: the history reads as usual, and there is no
              box to type an instruction into rather than one that fails.
            */
            <p className="app__readonly-note" role="note">
              閲覧権限で共有されたプロジェクトです。表示と履歴の確認だけができます（{project.access?.ownerName} さんが所有）。
            </p>
          ) : (
          <div className="app__chat-input-area">
            <div className="app__chat-input-capsule">
              <div className="app__chat-input-row">
                {attachControl}
                <textarea
                  ref={inputRef}
                  className="app__chat-input"
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={
                    chatMode === 'plan'
                      ? displayHtml ? '変更の方針を相談...' : '作りたいものを説明してください（まず構成案を出します）'
                      : selectedSelector ? `${selectedSelector} を変更...`
                      : displayHtml ? '変更を指示...'
                      : '何を作りたいですか？'
                  }
                  rows={1}
                  disabled={isProcessing}
                  aria-label="メッセージ入力"
                />
                {/*
                  Beside send, not above the box. It acts on what is in the box
                  and its result goes back into the box, so it belongs where the
                  text is — and it is deliberately quieter than send, because
                  sending is still the thing this composer is for.
                */}
                <button
                  className="app__chat-refine-btn"
                  onClick={() => refine(inputText)}
                  disabled={isProcessing || refining || !inputText.trim()}
                  aria-label="プロンプトを添削"
                  title="依頼文を、UIを作りやすい形に書き直します（Haiku）"
                  type="button"
                >
                  {refining ? (
                    <span className="app__chat-refine-spin" aria-hidden="true" />
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15.5l-1.9-4.6L5.5 9l4.6-1.4L12 3z" />
                      <path d="M18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9L18 15z" />
                    </svg>
                  )}
                </button>
                <button
                  className="app__chat-send-btn"
                  onClick={handleSend}
                  disabled={isProcessing || !inputText.trim()}
                  aria-label="送信"
                  type="button"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2l-1.41 1.41L16.17 9H4v2h12.17l-5.58 5.59L12 18l8-8z" transform="rotate(-90 12 12)" />
                  </svg>
                </button>
              </div>
              {(refinement || refineMessage) && (
                <div className="app__refine" role="status">
                  {refinement ? (
                    <>
                      <div className="app__refine-head">
                        <span className="app__refine-title">添削案</span>
                        <div className="app__refine-actions">
                          <button
                            className="app__refine-apply"
                            type="button"
                            onClick={() => { setInputText(refinement.prompt); clearRefinement(); inputRef.current?.focus(); }}
                          >
                            置き換える
                          </button>
                          <button className="app__refine-dismiss" type="button" onClick={clearRefinement} aria-label="添削案を閉じる">×</button>
                        </div>
                      </div>
                      <p className="app__refine-text">{refinement.prompt}</p>
                      {/*
                        What it added, not just what it wrote. A rewrite with no
                        account of itself is something to accept or reject blind,
                        and the sensible response to that is to reject it.
                      */}
                      {refinement.notes.length > 0 && (
                        <ul className="app__refine-notes">
                          {refinement.notes.map((n, i) => <li key={i}>{n}</li>)}
                        </ul>
                      )}
                    </>
                  ) : (
                    <div className="app__refine-head">
                      <span className="app__refine-msg">{refineMessage}</span>
                      <button className="app__refine-dismiss" type="button" onClick={clearRefinement} aria-label="閉じる">×</button>
                    </div>
                  )}
                </div>
              )}
              {image && (
                <div className="app__attach-preview">
                  <img src={image} alt={imageNotes[0] || '添付画像'} className="app__attach-thumb" />
                  {/*
                    What the picture shows, in the user's words.

                    The box lived in the extended chat, which is gone; the
                    capability is not part of that form. A described picture
                    never reaches the captioner — one vision call saved, and the
                    description is the user's rather than a guess at it.
                  */}
                  <input
                    className="app__attach-note"
                    value={imageNotes[0] ?? ''}
                    onChange={(e) => setImageNotes((prev) => {
                      const next = [...prev];
                      while (next.length <= 0) next.push('');
                      next[0] = e.target.value;
                      return next;
                    })}
                    placeholder="何の写真か／どこに置くか"
                    aria-label="添付画像 1 の説明"
                    disabled={isProcessing}
                  />
                  <button
                    className="app__attach-remove"
                    onClick={() => {
                      setImage(null);
                      // The descriptions are aligned by index with the pictures
                      // they describe. Dropping one without dropping its note
                      // slides every later note onto the wrong photo — and the
                      // note becomes that photo's alt text.
                      setImageNotes((prev) => prev.filter((_, n) => n !== 0));
                    }}
                    type="button"
                    aria-label="画像を削除"
                  >×</button>
                </div>
              )}
              {extraImages.map((src, i) => (
                <div className="app__attach-preview" key={`${i}-${src.slice(24, 48)}`}>
                  <img src={src} alt={imageNotes[i + 1] || `添付画像 ${i + 2}`} className="app__attach-thumb" />
                  {/*
                    Note `i + 1`, not `i`: the request is built as
                    `[image, ...extras]`, so the reference slot owns note 0 and
                    every extra is one along. Getting this wrong puts the right
                    sentence on the wrong photograph, and the sentence becomes
                    that photograph's alt text.
                  */}
                  <input
                    className="app__attach-note"
                    value={imageNotes[i + 1] ?? ''}
                    onChange={(e) => setImageNotes((prev) => {
                      const next = [...prev];
                      while (next.length <= i + 1) next.push('');
                      next[i + 1] = e.target.value;
                      return next;
                    })}
                    placeholder="何の写真か／どこに置くか"
                    aria-label={`添付画像 ${i + 2} の説明`}
                    disabled={isProcessing}
                  />
                  <button
                    className="app__attach-remove"
                    onClick={() => {
                      setExtraImages((prev) => prev.filter((_, n) => n !== i));
                      setImageNotes((prev) => prev.filter((_, n) => n !== i + 1));
                    }}
                    type="button"
                    aria-label={`画像 ${i + 2} を削除`}
                  >×</button>
                </div>
              ))}
              {pdfReading && (
                <div className="app__data-chip" aria-live="polite">
                  <span className="app__data-chip-name">PDF を読み取り中...</span>
                </div>
              )}
              {dataFile && (
                <div className="app__data-chip">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                    <path d="M14 2v6h6" />
                  </svg>
                  <span className="app__data-chip-name">{dataFile.name}</span>
                  {/*
                    The record count, not the file size. It is what the design
                    phase is told and what decides whether the screen gets search
                    and paging — so a wrong export is visible here rather than
                    after a generation has been spent on it.
                  */}
                  <span className="app__data-chip-meta">{describeAttachment(dataFile)}</span>
                  <button
                    className="app__attach-remove"
                    onClick={() => setDataFile(null)}
                    type="button"
                    aria-label="データファイルを削除"
                  >×</button>
                </div>
              )}
              {imageError && (
                <div className="app__attach-error" role="alert">{imageError}</div>
              )}
              {/* Controls inside the capsule: mode on the left, settings on the right */}
              <div className="app__composer-bar">
                <div className="app__composer-selects">
                  {composerSettings}
                </div>
                <div className="app__composer-actions">
                  {/*
                    The state the chip used to hold, without the chip.

                    「形式を変更」 was a toggle that unlocked the 形式 menu and armed
                    the next send as a generation. Both halves are now carried by
                    the menu itself: it is open, and choosing a format the document
                    is not means exactly what it says. What is left to show is that
                    the choice has consequences, which is a sentence and not a
                    control — pressing something to undo it would be picking the
                    document's own format back, in the menu that says so.
                  */}
                  {rebuilding && (
                    <span className="app__composer-note">
                      次のメッセージは {OUTPUT_KINDS.find((k) => k.id === outputKind)?.label ?? outputKind} で新しく作り直します
                    </span>
                  )}

                  {isProcessing && (
                    <button
                      className="app__chip app__chip--stop"
                      onClick={handleStop}
                      type="button"
                      title="実行中の生成を停止します（サーバー側の処理は完了まで進みます）"
                    >
                      <span className="app__chip-stop-icon" aria-hidden="true" />
                      停止
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
          )}
        </div>

        {/* Resize handle */}
        <div
          className={`app__resize-handle${isResizing ? ' app__resize-handle--active' : ''}`}
          style={{ left: chatWidth ? `${chatWidth - 2}px` : '40%' }}
          role="separator"
          aria-label="チャット幅を調整"
          aria-orientation="vertical"
          tabIndex={0}
          onMouseDown={() => setIsResizing(true)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') setChatWidth((w) => Math.max(280, (w ?? window.innerWidth * 0.4) - 20));
            if (e.key === 'ArrowRight') setChatWidth((w) => Math.min((w ?? window.innerWidth * 0.4) + 20, window.innerWidth - 400));
          }}
        />

        {/* Right: Preview / Code */}
        <main className="app__preview-pane">
          <div className="app__preview-toolbar">
            <div className="app__preview-tabs motion-track" role="tablist" aria-label="Preview/Code">
              <SlidingIndicator active={previewTab} />
              <button
                className={`app__preview-tab${previewTab === 'preview' ? ' app__preview-tab--active' : ''}`}
                onClick={() => setPreviewTab('preview')}
                role="tab"
                aria-selected={previewTab === 'preview'}
                type="button"
              >
                Preview
              </button>
              <button
                className={`app__preview-tab${previewTab === 'code' ? ' app__preview-tab--active' : ''}`}
                onClick={() => setPreviewTab('code')}
                role="tab"
                aria-selected={previewTab === 'code'}
                type="button"
              >
                Code
              </button>
            </div>
            <div className="app__viewport-chips motion-track" role="group" aria-label="Viewport">
              <SlidingIndicator active={device} />
              {DEVICES.map((d) => (
                <button
                  key={d.id}
                  className={`app__viewport-chip${device === d.id ? ' app__viewport-chip--active' : ''}`}
                  onClick={() => setDevice(d.id)}
                  type="button"
                  aria-pressed={device === d.id}
                  title={d.title}
                >
                  {d.label}
                </button>
              ))}
            </div>
            {versions.length > 0 && (
              /*
                Keyed by versionId, not by array index. The list refreshes when a
                run finishes, which pushes a new entry onto the front — with an
                index as the value, every existing selection would silently come
                to mean the version one older than the one the user picked.
              */
              <Dropdown
                label="バージョン"
                /*
                  `''` — the live document — resolves to the newest version,
                  because that is what it is: every path that changes the
                  document writes a version. Naming it rather than leaving the
                  trigger to fall back to the first row means the value shown
                  and the value held are the same thing.
                */
                value={selectedVersionId || versions[0].versionId}
                onChange={(id) => { void handleVersionSelect(id); }}
                disabled={versionLoading}
                title={versionLoading ? '読み込み中です' : undefined}
                options={versionOptions(versions)}
              />
            )}
            {/*
              Beside the selector it is about, and no longer inside the settings
              drawer.

              Not a placement preference: opening the comparison closed that
              drawer, and the drawer is what rendered this component, so the
              overlay was destroyed in the same commit that created it. A control
              that dismisses its own container cannot live inside it.
            */}
            {versions.length > 0 && (
              <VersionDiff
                currentHtml={displayHtml}
                versions={versions}
                apiUrl={apiUrl}
                token={token ?? ''}
                projectId={project.projectId}
              />
            )}
            {score && <span className="app__preview-score">{score}/100</span>}
          </div>

          {/*
            Both panes stay mounted; the inactive one is hidden.

            They used to be a ternary, so switching to the preview unmounted the
            editor and destroyed everything it held: which files were open, which
            was active, the scroll position, the cursor, the sidebar width — and,
            worst of all, `drafts`, the unsaved edits. Coming back showed
            index.html and nothing else, and any unsaved work had gone without
            passing the save/discard dialog that exists to prevent exactly that.

            Hiding rather than unmounting also means the preview iframe is not
            torn down and rebuilt on every switch, so returning to it no longer
            re-renders the document from scratch.
          */}
          <div className={`app__pane${previewTab === 'preview' ? '' : ' app__pane--hidden'}`}>
            <div className="app__preview-canvas">
              <div className={`app__preview-frame-wrap app__preview-frame-wrap--${device}`}>
                <Preview html={displayHtml} score={null} device={device}
                  title={projectTitle}
                  isGenerating={isProcessing}
                  phases={isModifying ? modifyPhases : phases}
                  generatingMode={isModifying ? 'modify' : 'generate'}
                  onElementSelected={(selector, anchor) => {
                  setSelectedSelector(selector);
                  setSelectedAnchor(anchor);
                  inputRef.current?.focus();
                }}
                  onRepairRuntimeError={repairRuntimeError} />
              </div>
            </div>
          </div>
          {/*
            An unsaved edit says so wherever you are.
            
            This used to live inside the selection panel, which is drawn only
            when an element is selected AND the preview tab is showing — so an
            edit made in the code editor, or one where the selection had been
            cleared, failed in silence. Measured on 2026-09-02: sixty-five hand
            edits were lost inside one minute to a DynamoDB throughput burst, and
            nothing on screen was obliged to mention it.

            It is a bar rather than a badge because the two questions somebody
            has at that moment — is my work gone, is trying again worth anything
            — need a sentence and a button, and neither fits beside a selector.
          */}
          {directEdit.status === 'error' && (
            <div className="app__save-failed" role="alert">
              <span className="app__save-failed-text">
                {directEdit.error ?? '保存に失敗しました。'}
              </span>
              <button type="button" className="app__save-failed-retry" onClick={directEdit.retry}>
                再試行
              </button>
            </div>
          )}
          <div className={`app__pane${previewTab === 'code' ? '' : ' app__pane--hidden'}`}>
            <div className="app__code-view app__code-view--vscode">
              {/*
                Editing here writes into the same layer the inspector uses, so
                the preview updates from the source and the two cannot disagree
                about what the document is.
              */}
              <CodeEditor html={displayHtml} onEditFile={readOnly ? undefined : directEdit.editSource} />
            </div>
          </div>

          {/*
            The editor panel belongs to the preview, and on the code tab it is
            reduced to a single line.

            It grew from three read-only rows to eight editable fields plus a
            textarea, and on the code tab that pushed the editor down to a few
            visible lines — selecting an element effectively closed the code
            view. The selection is still worth showing there, because it is how
            you find the element in the source, but only the selector is: the
            controls edit a rendered page, which is not what that tab is for.
          */}
          {selectedSelector && previewTab === 'code' && (
            <p className="app__selected-selector app__selected-selector--compact" aria-live="polite">
              Selected: <code>{selectedSelector}</code>
              <button type="button" className="app__edit-revert" onClick={() => setPreviewTab('preview')}>
                プレビューで編集
              </button>
            </p>
          )}

          {selectedSelector && previewTab === 'preview' && (
            <div className="app__selected-info">
              {/* Floating panels need a way out; there is no longer an edge to
                  scroll past to dismiss it. */}
              <button
                type="button"
                className="app__selected-close"
                onClick={() => setSelectedSelector(null)}
                aria-label="要素の選択を解除"
              >
                ×
              </button>
              <CSSInspector
                selector={selectedSelector}
                html={displayHtml}
                onEdit={readOnly ? undefined : directEdit.editStyle}
                onEditText={!readOnly && directEdit.canEditText ? directEdit.editText : undefined}
              />
              {/*
                Shown only when the preview could trace this element back to a
                line. A mock, a framework wrapper, or a build made without
                anchors has nothing to edit, and offering the buttons anyway
                would be offering an action that cannot be taken.
              */}
              {selectedAnchor && (
                <div className="app__structural">
                  <span className="app__structural-label">要素</span>
                  <button type="button" className="app__structural-btn"
                    onClick={() => applyStructural('up')} title="ひとつ前へ">↑</button>
                  <button type="button" className="app__structural-btn"
                    onClick={() => applyStructural('down')} title="ひとつ後へ">↓</button>
                  <button type="button" className="app__structural-btn app__structural-btn--danger"
                    onClick={() => applyStructural('delete')} title="この要素を削除">削除</button>
                  <code className="app__structural-at">{selectedAnchor}</code>
                </div>
              )}
              {/*
                Only when the element holds text and nothing else. An element
                carrying a binding or a child element is not editable this way —
                replacing its content would delete either one while looking like
                a wording change — and the field is absent rather than disabled,
                because there is nothing to explain about a control that was
                never offered for this element.
              */}
              {selectedAnchor && anchoredText !== null && (
                <TextField key={selectedAnchor} initial={anchoredText} onCommit={applyText} />
              )}
              {structuralNote && (
                <p className="app__structural-note" role="status">{structuralNote}</p>
              )}
              <p className="app__selected-selector" aria-live="polite">
                Selected: <code>{selectedSelector}</code>
                {/*
                  The two transient ones stay here, beside the selection they
                  belong to. The failure does not — see the bar below the panes.
                */}
                {directEdit.status === 'saving' && <span className="app__edit-status">保存中…</span>}
                {directEdit.status === 'saved' && <span className="app__edit-status">保存しました</span>}
                {directEdit.edited && (
                  <button type="button" className="app__edit-revert" onClick={directEdit.revertAll}>
                    手動編集をすべて取り消す
                  </button>
                )}
              </p>
            </div>
          )}
        </main>

      </div>
    </div>
  );
}

