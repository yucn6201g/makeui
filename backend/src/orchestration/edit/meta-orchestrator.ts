/**
 * The edit pipeline: one change instruction applied to an existing project,
 * then checked and repaired the way a generated one is.
 */
import { InvokeModelCommand, InvokeModelWithResponseStreamCommand } from '@aws-sdk/client-bedrock-runtime'
import { resolveModelForPrompt, type ModelChoice } from '../../config/model-config.js'
import { effortProfile, type Effort } from '../../config/effort.js'
import { DEFAULT_OUTPUT_KIND, FRAMEWORKS, type OutputKind } from '../../config/frameworks.js'
import { detectKind } from '../../tools/project/framework-compile.js'
import { fixupProject } from '../../tools/fixups/framework-fixups.js'
import { applyPresetFoundation } from '../presets/preset-foundation.js'
import { repairable } from '../repair/repair-yield.js'
import { moduleDefects } from '../../tools/project/react-bundle.js'
import { readProjectFiles, writeProjectFile } from '../../tools/project/project-transport.js'
import { appendJobEvent, tokenHeartbeat, updateJobStream } from '../../services/job-service.js'
import { allowedModelsForRun } from '../../services/token-usage.js'
import { auditAiTells } from '../audit/design-audit.js'
import { planModifyWorkflow, summariseDocument } from '../generate/workflow-router.js'
import { stripFences, STREAM_FLUSH_MS } from '../generate/model-calls.js'
import { getPresetSpec, presetConformance, resolveUserDesignSystem } from '../presets/design-presets.js'
import { FORM_CONTROL_SIZING } from '../prompts/prompt-contracts.js'
import { describeEditReply } from '../prompts/reply-text.js'
import { diagnoseForChange } from './change-diagnosis.js'
import {
  extractRequirements,
  checkRequirements,
  requirementDefects,
  summarizeRequirements,
  type RequirementResult,
} from '../generate/requirements.js'
import { pickStockImages, stockImageInstructions, repairStockUrls } from '../../tools/images/stock-images.js'
import { assignItemImages } from '../../tools/images/assign-images.js'
import { resolveSubjects } from '../../tools/images/subject-resolve.js'
import { logger } from '../../utils/logger.js'
import { lean, restore, EMBEDDED_IMAGE_NOTE } from '../../utils/embedded-images.js'
import {
  parseImageInput,
  userContentWithImage,
  embedUserImage,
  imageCaptionNote,
  isEmbeddable,
  USER_IMAGE_TOKEN,
  type ImageInput,
} from '../../utils/image-input.js'
import { embedContentImages, stripContentImageTokens } from '../../utils/content-images.js'
import { prepareSuppliedImages } from '../generate/supplied-images.js'
import { parseAttachment, attachmentDirective, type RawAttachment } from '../../utils/data-attachment.js'
import type { RequestPart } from './edit-files.js'
import { createBedrockClient } from '../../config/bedrock-client.js'
import {
  withTokenLedger,
  recordTokens,
  recordUnreportedCall,
  logLedger,
  type TokenLedger,
} from '../../services/token-ledger.js'
import { isModelUnavailable } from '../../utils/failure-message.js'

const bedrockClient = createBedrockClient()

/** Files one Bedrock response's real usage into the run's ledger. */
function reportUsage(body: any, where: string): void {
  if (typeof body?.usage?.input_tokens === 'number') {
    recordTokens(body.usage.input_tokens, body.usage.output_tokens ?? 0, where, {
      read: body.usage.cache_read_input_tokens ?? 0,
      write: body.usage.cache_creation_input_tokens ?? 0,
    })
  } else {
    recordUnreportedCall(where)
  }
}

/**
 * A plain text completion, for the passes that need one rather than a document.
 *
 * `stage` is not optional in practice, and it is the whole reason this signature
 * changed. Every call reported under the one label `meta:invokeText`, so the
 * modify path's largest stage — 65% of six measured edits — could say only that
 * it was "text", covering the edit planner, the per-file edit writers and the
 * empty-container filler at once. The generate path names the same three jobs
 * separately (`repair:plan`, `repair:per-file`, `repair:fill-empty`), which is
 * how its 33.8% could be attributed and acted on; the edit path could not be.
 *
 * A stage split that resolves to one bucket is a total with extra steps.
 */
async function invokeText(modelId: string, system: string, user: string, maxTokens: number, stage = 'meta:invokeText'): Promise<string> {
  const response = await bedrockClient.send(
    new InvokeModelCommand({
      modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    })
  )
  const body = JSON.parse(new TextDecoder().decode(response.body))
  reportUsage(body, stage)
  return body.content?.[0]?.text ?? ''
}

/**
 * A model call with image blocks, for captioning the pictures attached to an edit.
 *
 * Takes the model id as a promise so the caller need not resolve configuration
 * before it knows there is anything to caption. Billed under the same stage the
 * build's captioning uses.
 */
async function invokeVision(modelId: Promise<string>, system: string, content: Array<Record<string, unknown>>, maxTokens: number): Promise<string> {
  const response = await bedrockClient.send(
    new InvokeModelCommand({
      modelId: await modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content }],
      }),
    })
  )
  const body = JSON.parse(new TextDecoder().decode(response.body))
  reportUsage(body, 'images:caption')
  return body.content?.[0]?.text ?? ''
}

/** What the browser measured, mirrored from the generation pipeline's shape. */
interface EditVerification {
  screens: { id: string; fill: number }[]
  emptyBoxes: number
  consoleErrors: number
  deadNav: number
  /** Buttons inside a screen that were pressed and did nothing. */
  deadActions: number
  /** Form controls that rendered too small to use. */
  smallFields: number
  unreachable: string[]
  /** Text measured below the WCAG AA floor on the rendered page. */
  contrast: { text: string; ratio: number; required: number }[]
  /** Sideways scroll at 390px width, in pixels. 0 when there is none. */
  mobileOverflowPx: number
}

/** Same switch the generation pipeline uses, so both can be turned off together. */
const BROWSER_VERIFY_ENABLED = process.env.BROWSER_VERIFY_ENABLED === '1'

/**
 * What a whole-document rewrite of a React project must preserve.
 *
 * This used to be prepended to the user's instruction by the API handler, which
 * put twelve hundred characters of format rules in front of every downstream
 * reader of "what the user asked for". Measured on a real edit: the file-edit
 * planner received the boilerplate with 「お問い合わせページを作成してください」 as its
 * last line and returned no plan, so the edit did nothing at all. The guard also
 * contains 「画面を追加する場合は」, which made the structural-instruction keyword
 * test true for every edit ever made to a React project.
 *
 * It belongs to this prompt and only this prompt. The per-file path hands the
 * model one file and asks for one file, where "keep every data-file block
 * intact" describes nothing it could do wrong.
 */
/**
 * What a whole-document rewrite of a project must preserve.
 *
 * This used to be prepended to the user's instruction by the API handler, which
 * put twelve hundred characters of format rules in front of every downstream
 * reader of "what the user asked for". Measured on a real edit: the file-edit
 * planner received the boilerplate with 「お問い合わせページを作成してください」 as its
 * last line and returned no plan, so the edit did nothing at all. The guard also
 * contains 「画面を追加する場合は」, which made the structural-instruction keyword
 * test true for every edit ever made to a project.
 *
 * It belongs to this prompt and only this prompt. The per-file path hands the
 * model one file and asks for one file, where "keep every fence intact"
 * describes nothing it could do wrong.
 *
 * Two things about it were wrong until now, and they compounded.
 *
 * It was React's guard, applied to every project of any kind — so a Vue project
 * arriving here was told to keep its files as TypeScript React. And it was
 * gated on `<script type="text/jsx">`, the transport React projects travelled
 * in before components carrying their own `<script>` forced the move to line
 * fences. Nothing has emitted that attribute since, so the gate was false for
 * every document and the guard was attached to nothing at all. The prompt below
 * it, meanwhile, still described a single HTML page with `<style data-file>`
 * blocks — a format this product stopped producing entirely. A Vue project fell
 * through the per-file path, reached this prompt, and was rewritten by a model
 * whose only instructions were about a document shape it was not holding.
 */
const FENCE_GUARD = `

PROJECT — この文書はソースファイルの集合です。HTMLのページではありません。
次の形式を必ず維持してください:
- 各ソースファイルは次の行フェンスで区切られています。この形式のまま返してください:

    @@@makeui:file src/App.vue
    …ファイルの中身をそのまま…
    @@@makeui:endfile

- フェンスは必ず行全体です。ファイルを <script> や <style> で包まないでください
  （コンポーネント自身の <script>/<style> はフェンスの中にそのまま書きます）
- ブロックを結合・削除・リネームしない。同じパスを二重に出力しない
- <!DOCTYPE html> で始め、フェンスされたファイルだけを並べ、</body></html> で閉じる
- 既存の import/export 関係と型定義を壊さない
- **この文書に既にあるフォルダ構成をそのまま踏襲する**。新しい構成に作り替えない。
  既存ファイルのパスを読んで、どこに何が置かれているかを把握してから書く
- 新しいファイルを import したら、そのファイルも必ず同じ出力に含める。
  import だけ書いてファイルを書かないと、最初の解決で例外になり画面が1つも出ません
- アイコンは既存のインライン SVG コンポーネントを import して使う。絵文字をアイコンとして
  使わない。新しいアイコンが必要なら既存のアイコンディレクトリに追加する
- 図版が必要な箇所は灰色の枠ではなくインライン SVG を描く
- ログイン画面を追加・変更する場合は、デモ用の認証情報を画面上に見える形で表示し、
  その認証情報でログインが通るようにする
- SPECIFICATION.md を更新する。変更が仕様に影響する場合は該当箇所を書き換える。削除は禁止`

/**
 * The guard for whichever framework the document is actually written in, or
 * nothing when it is not a project at all.
 *
 * Read from the files rather than from what the user picked in the composer:
 * an edit is handed a project and returns one, and the framework is whatever
 * the paths say it is.
 */
function projectModifyGuard(html: string): string {
  const kind = detectKind(readProjectFiles(html).keys())
  if (!kind) return ''
  const fw = FRAMEWORKS[kind]
  return `${FENCE_GUARD}
- これは ${fw.label} プロジェクトです。別のフレームワークに書き換えないでください。
  ファイルの拡張子（${fw.editExt.join(' / ')}）を変えないこと
- 依存パッケージを増やさない（使えるのは ${fw.packages}）
${fw.editGuard}`
}


/**
 * Direct Bedrock call: apply a modification instruction to an HTML document
 * and return the complete modified HTML.
 *
 * Why not Strands orchestrator?
 * The previous agent-as-tool chain was broken: specialist tools returned CSS
 * or JSON plan objects, not full HTML. The orchestrator had only 8k chars of
 * the original HTML in its system prompt and could not reconstruct the full
 * document. Every call returned `html === original` → frontend showed error.
 *
 * For HTML→HTML modification a single focused model call is faster, cheaper,
 * and more reliable than a multi-agent chain. Strands multi-agent is still
 * used for the full generate pipeline (design-analyst → code-assembler → review).
 */
/**
 * Large document (> 25k chars): ask the model for CSS only, and apply it.
 *
 * The cheap restyle path. It exists so 「ボタンを丸くして」 does not have to
 * re-emit eighty thousand characters of project to change one radius.
 *
 * It used to finish by injecting `<style data-file="styles/overrides.css">` into
 * the document — the transport React projects used before line fences. Every
 * generated project is comfortably over 25k, so this path takes essentially
 * every non-structural styling instruction, and in a fenced document that block
 * is invisible: measured on a real project, `readProjectFiles` went 33 files in
 * and 33 files out, and the compiled preview did not contain the rule.
 *
 * The failure mode is the worst one available. The model is called and paid for,
 * the block comes back, the job completes, the UI is reported as modified — and
 * nothing about it changed, with no error anywhere to say so.
 *
 * A project now has the CSS appended to its own stylesheet through the
 * transport, which is where the styling contract says the design lives. Legacy
 * HTML documents keep the injected block, which is correct for them.
 */
async function cssOverrideModify(html: string, instruction: string, modelId: string, preset?: string): Promise<string> {
  const files = readProjectFiles(html)
  const isProject = detectKind(files.keys()) !== null
  // The project's own stylesheet, by what it has rather than by convention, so
  // a project that named it something else still gets the edit.
  const sheetPath =
    [...files.keys()].find((p) => p === 'src/styles/globals.css') ??
    [...files.keys()].find((p) => p.endsWith('.css')) ??
    'src/styles/globals.css'
  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 8000,
    system: `You are an expert frontend designer specialising in CSS.
The user wants to visually transform an existing HTML page.
Generate ONLY a <style> block with CSS that overrides the existing styles to apply the transformation.
The <style> block will be injected after all existing styles, so your CSS will naturally take precedence.
Use specific selectors and add overrides as needed.

RULES:
${isProject
  ? `- Return ONLY raw CSS — no <style> tag, no markdown fences, no explanation.
- It is appended to ${sheetPath}, so write rules that override what is already
  there: reuse the existing class names, and reach for !important only where
  specificity genuinely requires it.`
  : `- Return ONLY a single <style data-file="styles/overrides.css">...</style> block — nothing else
- The data-file attribute is REQUIRED (the editor renders each block as its own project file)`}
- Be thorough: cover typography, colors, spacing, layout, components
- Do NOT wrap in markdown code fences
- Do NOT include any explanation${
  /*
   * The bound system, as the full rewrite states it. This path used to read the
   * preset only to switch on 'wireframe', so a stylesheet override to a page
   * built on any other system was written without its palette or radii.
   */
  preset && getPresetSpec(preset)
    ? `\n\nBINDING DESIGN SYSTEM — the page was built to this and must stay on it. Use ONLY these values:\n${getPresetSpec(preset)}`
    : ''}`,
    messages: [{
      role: 'user',
      content: `Transformation instruction: "${instruction}"\n\nHTML to transform (for reference):\n${html.slice(0, 40000)}`,
    }],
  })

  const response = await bedrockClient.send(new InvokeModelCommand({
    modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body,
  }))

  const result = JSON.parse(new TextDecoder().decode(response.body))
  reportUsage(result, 'meta:stylePass')
  const text: string = result.content?.[0]?.text ?? ''

  // Extract <style> block (strip any accidental markdown fences)
  let styleBlock = text.replace(/^```css\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```\s*$/, '').trim()

  /*
   * A project takes the CSS into its own stylesheet.
   *
   * The model was asked for raw CSS, but it was asked by a prompt, so it
   * sometimes wraps the answer anyway. The tag is unwrapped rather than trusted.
   */
  if (isProject) {
    const inner = /<style[^>]*>([\s\S]*?)<\/style>/i.exec(styleBlock)
    const css = (inner ? inner[1] : styleBlock).trim()
    if (!css) {
      logger.warn('Style pass returned nothing to apply', { sheetPath })
      return html
    }
    const existing = files.get(sheetPath) ?? ''
    const next = `${existing.replace(/\s+$/, '')}\n\n/* --- 変更指示による追加 --- */\n${css}\n`
    const written = writeProjectFile(html, sheetPath, next)
    if (written === null) {
      // The CSS carried something that would break the transport. Changing
      // nothing beats corrupting the document.
      logger.warn('Style pass produced CSS the transport refused', { sheetPath })
      return html
    }
    logger.info('Style pass appended to the project stylesheet', { sheetPath, added: css.length })
    return written
  }

  const styleMatch = styleBlock.match(/<style[\s\S]*?<\/style>/i)
  if (styleMatch) {
    styleBlock = styleMatch[0]
  } else if (!styleBlock.toLowerCase().startsWith('<style')) {
    styleBlock = `<style data-file="styles/overrides.css">\n${styleBlock}\n</style>`
  }
  // Guarantee the override block is a named file in the virtual project tree
  if (!/data-file=/i.test(styleBlock)) {
    styleBlock = styleBlock.replace(/^<style/i, '<style data-file="styles/overrides.css"')
  }

  // Inject before </head>, or before </body>, or at end
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, () => `${styleBlock}\n</head>`)
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, () => `${styleBlock}\n</body>`)
  return html + '\n' + styleBlock
}

/**
 * Small HTML (≤ 25k chars): ask model to regenerate the full modified document.
 */
async function fullHtmlModify(rawHtml: string, instruction: string, modelId: string, maxTokens: number, dataContext: string, preset?: string, onDelta?: (t: string) => void, onPlan?: (p: string) => void, changeSpec?: string, image?: ImageInput | null, stockBlock?: string): Promise<string> {
  /*
   * The pictures come out before the document goes in.
   *
   * This prompt ends with `Current HTML:` and the WHOLE document, so a project
   * carrying two supplied photographs sent about 150,000 tokens of base64 into
   * one call and asked the model to reproduce it character for character. See
   * utils/embedded-images.ts — the cost, the corruption risk and the length
   * guard it breaks are all the same fault.
   *
   * The markers go back at the end of this function, so every caller sees the
   * document it expects.
   */
  const leaned = lean(rawHtml)
  const html = leaned.text
  if (leaned.images.size > 0) {
    logger.info('Took embedded images out of the rewrite prompt', {
      images: leaned.images.size,
      charsSaved: leaned.saved,
    })
  }

  /**
   * The bound design system, restated for the edit.
   *
   * Generation received the full preset spec; edits received only the preset
   * *name*, and then only to switch on 'wireframe'. So every instruction was
   * applied by a model that had never been told which palette, type scale or
   * radius the page was built to — and each edit pulled the page a little
   * further towards the model's own defaults. Restating it makes the system
   * binding for the whole life of the document, not just its first minute.
   */
  const presetSpec = preset && preset !== 'none' ? getPresetSpec(preset) : ''
  const presetConstraint = presetSpec
    ? `\n\nBINDING DESIGN SYSTEM — the document was built to this and must stay on it.\nUse ONLY these values for anything you add or change. Never introduce a colour,\nfont, radius or shadow that is not defined here.\n${presetSpec}`
    : ''
  /**
   * The block-preservation rules describe two different documents, and sending
   * the wrong one is not a smaller mistake than sending none.
   *
   * Every project this product now generates is a set of fenced source files.
   * The `<style data-file="…">` / `<script data-file="…">` instructions below
   * describe the single-page HTML output that was removed — so a model holding
   * a Vue project was being told, in detail, to maintain a structure it could
   * not see. The reasonable thing to do with that instruction is to produce the
   * document it describes, which is exactly what came back.
   */
  const isProject = detectKind(readProjectFiles(html).keys()) !== null
  const structureRules = isProject
    ? `- CRITICAL: the document is a set of source files separated by whole-line fences
  (@@@makeui:file <path> … @@@makeui:endfile). Preserve every fence and its path exactly.
- Add a new file by adding a new fenced block; never wrap a file in <script> or <style>.
- Styling belongs in the existing CSS file under src/styles/, not in a <style> tag.`
    : `- CRITICAL: the document splits CSS/JS across multiple <style data-file="..."> / <script data-file="..."> blocks. Preserve every block and its data-file attribute exactly.
- Add new CSS to the block whose data-file matches the concern (tokens/base/layout/components/animations/responsive); if none fits, add <style data-file="styles/overrides.css"> before </head>
- Add new JS to the matching scripts/*.js block; if none fits, add <script data-file="scripts/extra.js"> before </body>`

  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: maxTokens,
    system: `You are an expert frontend engineer specialising in UI modification.
Apply the user's modification instruction to the document and return it complete.

RULES:
- Return ONLY the complete document starting with <!DOCTYPE html> or <html
- Apply the modification thoroughly and precisely
- Preserve ALL parts not affected by the change: IDs, class names, scripts, CSS, structure
${structureRules}
- Do NOT wrap output in markdown code fences

OUTPUT SHAPE — a short plan, then the document:
  First write 2-4 short lines in Japanese saying what you are changing and why,
  as a plain sentence each, no headings and no bullet markers. This is shown to
  the user while the edit runs.
  Then, on a new line, the complete document starting with <!DOCTYPE html>.
  Write nothing after the closing </html>.

QUALITY — the edit must leave the page better, never merely different:
- Keep the existing design language: reuse the tokens, spacing scale, radii and
  type scale already in the document rather than introducing new values.
- If the instruction is vague, resolve it the way a careful designer would:
  adjust the whole affected component and its states, not just one declaration.
- Preserve hover/focus-visible/active/disabled states on anything you touch, and
  add them if the element you are editing is missing them.
- Never regress accessibility: keep landmarks, labels, aria attributes and contrast.
- No placeholder text, no "coming soon", no dead controls introduced by the edit.
- NO EMOJI anywhere in the interface — not in labels, buttons, headings, status
  text or data. If an icon is needed use an inline SVG; if it was decoration,
  delete it. Never introduce one that was not already there.
- Do not introduce gradient headline text, glassmorphism, coloured glow shadows,
  or the indigo/violet default palette.
${FORM_CONTROL_SIZING}${projectModifyGuard(html)}${presetConstraint}${leaned.images.size > 0 ? EMBEDDED_IMAGE_NOTE : ''}`,
    messages: [{
      role: 'user',
      // The image goes first, ahead of the instruction and the document, so the
      // model reads the reference before the thing it is being asked to change.
      content: userContentWithImage(
        `Modification instruction: "${instruction}"${
          image
            ? '\n\nAn image is attached. Decide from the instruction which it is: a DESIGN REFERENCE ' +
              '(take layout, palette, type treatment and component patterns from it, preferring it over ' +
              'your own instincts where they disagree), or CONTENT TO DISPLAY — the user wants this ' +
              `picture on the screen. For the latter write ${USER_IMAGE_TOKEN} as the src and it will be ` +
              `replaced with the real image: <img src="${USER_IMAGE_TOKEN}" alt="…">, styled as a real ` +
              'photograph would be (object-fit: cover inside a sized box). It can be both.'
            : ''
        }${
          changeSpec
            ? `\n\nBUILD CONTRACT — an interaction designer specified this change. Implement it exactly: every screen, control and state write listed here must exist and work.\n${changeSpec}`
            : ''
        }${stockBlock ?? ''}${dataContext ?? ''}\n\nCurrent HTML:\n${html}`,
        image ?? null
      ),
    }],
  })

  // Streamed when the caller wants live output, so the client can show the
  // response being written instead of only a spinner.
  let text = ''
  if (onDelta) {
    const streamed = await bedrockClient.send(new InvokeModelWithResponseStreamCommand({
      modelId, contentType: 'application/json', accept: 'application/json', body,
    }))
    let inputTokens = 0
    let outputTokens = 0
    for await (const event of streamed.body ?? []) {
      const bytes = event.chunk?.bytes
      if (!bytes) continue
      try {
        const payload = JSON.parse(new TextDecoder().decode(bytes))
        if (payload.type === 'message_start') {
          inputTokens = payload.message?.usage?.input_tokens ?? 0
          outputTokens = payload.message?.usage?.output_tokens ?? 0
        } else if (payload.type === 'content_block_delta' && typeof payload.delta?.text === 'string') {
          text += payload.delta.text
          onDelta(text)
        } else if (payload.type === 'message_delta' && typeof payload.usage?.output_tokens === 'number') {
          outputTokens = payload.usage.output_tokens
        }
      } catch { /* ignore malformed chunk */ }
    }
    if (inputTokens || outputTokens) recordTokens(inputTokens, outputTokens, 'meta:rewrite:stream')
    else recordUnreportedCall('meta:rewrite:stream')
  } else {
    const response = await bedrockClient.send(new InvokeModelCommand({
      modelId, contentType: 'application/json', accept: 'application/json', body,
    }))
    const result = JSON.parse(new TextDecoder().decode(response.body))
    reportUsage(result, 'meta:rewrite')
    text = result.content?.[0]?.text ?? ''
  }

  /*
   * Every way out of this function puts the pictures back.
   *
   * A marker that reached a caller would be a broken `src` in a shipped
   * document, and a picture dropped by the model is reported rather than
   * silently restored — removing one can be exactly what was asked for.
   */
  const withImages = (out: string): string => {
    const back = restore(out, leaned.images)
    if (back.missing.length > 0) {
      logger.info('The rewrite did not keep every embedded image', {
        restored: back.restored,
        dropped: back.missing.length,
      })
    }
    return back.text
  }

  // Strip markdown code fences
  let cleaned = stripFences(text)

  // Skip preamble before HTML document starts
  const doctypeIdx = cleaned.search(/<!DOCTYPE html/i)
  const htmlTagIdx = cleaned.search(/<html[\s>]/i)
  const startIdx = doctypeIdx >= 0 ? doctypeIdx : htmlTagIdx >= 0 ? htmlTagIdx : -1
  if (startIdx > 0) {
    // The preamble is the model's plan for this edit — surface it instead of
    // dropping it, so the chat keeps the reasoning the way generation does.
    onPlan?.(stripFences(cleaned.slice(0, startIdx)))
    cleaned = cleaned.slice(startIdx)
  }

  // Prefer full document with closing tag
  const match = cleaned.match(/<!DOCTYPE html[\s\S]*<\/html>/i)
    ?? cleaned.match(/<html[\s\S]*<\/html>/i)
  if (match) return withImages(match[0])

  // Accept truncated output if it at least contains body content
  if (cleaned.startsWith('<') && cleaned.length > 200 && /<body[\s>]/i.test(cleaned)) return withImages(cleaned)

  // Returning the input unchanged is indistinguishable from "the model declined",
  // and the caller reports it to the user as a failed edit with no reason. Fail
  // loudly instead so the real cause reaches the chat.
  logger.warn('fullHtmlModify: no usable HTML in response', { textLen: text.length, preview: text.slice(0, 300) })
  throw new Error(
    text.length === 0
      ? 'モデルから応答がありませんでした。もう一度お試しください。'
      : '変更結果が途中で切れました。指示を小さく分けてお試しください。'
  )
}

/**
 * Applies an instruction to a project by rewriting only the files it touches.
 *
 * The alternative — and what this replaces — is asking for the whole project
 * back. A generated project is thirty-odd files across eighty kilobytes, so
 * "add a report screen" meant re-emitting thirty files that were not part of the
 * change, at 25-32k output tokens, with a truncation risk that grew with the
 * document. Structural edits were the standing complaint about this product and
 * this was the shape that produced them.
 *
 * Returns null rather than throwing whenever it cannot see the change through,
 * so the caller falls back to the whole-document rewrite. A path that can only
 * add is a path that can be trusted with the default.
 */
async function projectFileModify(
  html: string,
  instruction: string,
  modelId: string,
  changeSpec: string,
  dataContext: string,
  /** The request's separate parts, so each file is told only its own. */
  parts: RequestPart[],
  onDelta?: (t: string) => void,
  onPlan?: (p: string) => void
): Promise<string | null> {
  const { planFileEdits, applyFileEdits, describeEditOutcome } = await import('./edit-files.js')
  // Planning and rewriting are one call each in shape and nothing alike in
  // size: the plan is one short reply, a rewrite is a file. Named apart for
  // the same reason the generate path names them apart.
  const planInvoke = (system: string, user: string) => invokeText(modelId, system, user, 16000, 'edit:plan')
  const writeInvoke = (system: string, user: string) => invokeText(modelId, system, user, 16000, 'edit:per-file')

  const plans = await planFileEdits(html, instruction, changeSpec, planInvoke, dataContext, parts)
  if (plans.length === 0) {
    logger.info('Per-file edit declined — no plan', { instruction: instruction.slice(0, 80) })
    return null
  }

  // The plan is the only thing there is to show before the files land, and it is
  // more informative than the spinner it replaces: the user sees which files the
  // change was understood to touch while it is being made.
  const summary = plans
    .map((p) => `${p.create ? '新規' : '編集'} ${p.path}${p.reason ? ` — ${p.reason}` : ''}`)
    .join('\n')
  onPlan?.(summary)
  onDelta?.(summary)
  logger.info('Per-file edit planned', { files: plans.map((p) => `${p.create ? '+' : '~'}${p.path}`) })

  const { html: edited, written, skipped } = await applyFileEdits(html, plans, instruction, changeSpec, writeInvoke, dataContext, parts)
  logger.info('Per-file edit applied', { written, skipped })
  if (written.length === 0) return null

  /*
   * The plan again, now that it is known which parts of it happened.
   *
   * Emitted through the same channel the plan went out on, so the panel the
   * user is already looking at is replaced by the outcome rather than left
   * showing an intention. Before this, a partial edit — three of a request's
   * four parts — reported the plan, applied what it could, and returned with no
   * new defects and a clean browser, which reads as success.
   */
  const outcome = describeEditOutcome(plans, written, skipped)
  onPlan?.(outcome.summary)
  onDelta?.(outcome.summary)
  if (outcome.partial) {
    logger.warn('Per-file edit was partial', {
      instruction: instruction.slice(0, 120),
      applied: written,
      unapplied: outcome.unapplied.map((p) => `${p.path}${p.reason ? ` (${p.reason})` : ''}`),
    })
  }

  /**
   * The same two corrections the generation path applies after assembly.
   *
   * An edit that adds a component adds imports, and an import of a directory
   * needs a barrel that the file writing the import has no way to create. Left
   * undone this is the `Module not found` failure that took the whole preview
   * down, reintroduced by every edit that adds a folder.
   */
  const { normalizeReactExtensions, addMissingBarrels } = await import('../../tools/project/react-bundle.js')
  const normalised = normalizeReactExtensions(edited)
  const barrelled = addMissingBarrels(normalised.html)
  if (normalised.renamed.length || barrelled.added.length) {
    logger.info('Per-file edit repaired module layout', {
      renamed: normalised.renamed,
      barrels: barrelled.added,
    })
  }
  /**
   * And a last free pass over syntax. An edit rewrites whole files, so it can
   * introduce the fault that stops the bundle — and on this path there is no
   * repair loop behind it to notice. Only applied when the result compiles.
   */
  const { repairSyntax } = await import('../repair/syntax-repair.js')
  const syntax = repairSyntax(barrelled.html)
  if (syntax.repairs.length > 0) {
    logger.info('Per-file edit repaired syntax', {
      repairs: syntax.repairs.map((r) => `${r.path}:${r.line}`),
    })
  }
  return correctIdioms(syntax.html, 'Per-file edit')
}

/**
 * The framework corrections generation applies, applied to an edit too.
 *
 * `fixupProject` ran after a generation's build and after its repair loop, and
 * on no edit path at all. An edit that adds a component writes the component and
 * the import in separate files, which is exactly where a named import of a
 * default export comes from — React #130, a blank screen, measured on both live
 * generations of 2026-09-13 and in 11 of 36 shipped projects. Generation now
 * rewrites that in milliseconds; an edit was shipping it, or paying a repair
 * call to describe it.
 */
function correctIdioms(html: string, label: string): string {
  const kind = detectKind(readProjectFiles(html).keys())
  if (!kind) return html
  const corrected = fixupProject(html, kind)
  if (corrected.fixed.length > 0) {
    logger.info(`${label} repaired framework idioms`, { fixed: corrected.fixed.slice(0, 6) })
  }
  return corrected.html
}

// Keywords that indicate structural modification (adding elements, sections, tabs, pages).
// When detected, always use full-HTML rewrite regardless of document size.
const STRUCTURAL_KEYWORDS = ['タブ', 'ページ', '画面', 'セクション', '追加', '新しい', '新規', 'section', 'tab', 'page', 'add ', 'insert', 'append', 'spa-page']

function isStructuralInstruction(instruction: string): boolean {
  const lower = instruction.toLowerCase()
  return STRUCTURAL_KEYWORDS.some(k => lower.includes(k.toLowerCase()))
}

async function directModify(
  html: string,
  instruction: string,
  modelId: string,
  maxTokens: number,
  /**
   * The user's data file, sampled — `''` when the edit carries none.
   *
   * REQUIRED, and positioned ahead of the optionals on purpose. It was optional
   * and trailing, and the one call site that mattered simply did not pass it:
   * every layer below had been threaded, the parse ran, the directive was built,
   * and it was dropped in the argument list. TypeScript cannot see an omitted
   * optional parameter, so an edit carrying a CSV rewrote the document without
   * it and reported success. Required means the compiler asks.
   */
  dataContext: string,
  /**
   * The request's separate parts. One entry when the request asked one thing,
   * so callers have a single shape; required for the same reason `dataContext`
   * is, since an omitted optional is the mistake this file has already made.
   */
  parts: RequestPart[],
  preset?: string,
  onDelta?: (t: string) => void,
  onPlan?: (p: string) => void,
  /** Build contract produced by the change designer, when the edit warranted one. */
  changeSpec?: string,
  /** Set when the router classified the edit as structural or behavioural. */
  forceFullRewrite?: boolean,
  /** A reference image attached to the edit request, if any. */
  image?: ImageInput | null,
  /** Real photograph URLs offered to this edit, when it asked for imagery. */
  stockBlock?: string,
): Promise<string> {
  /**
   * A project is edited file by file, whichever framework it is written in.
   *
   * Both of the other paths are wrong for it. The CSS-override path appends a
   * stylesheet to a project whose styling lives in its own files, so the edit
   * lands outside the code the user then reads. The full-rewrite path asks for
   * thirty files back to change one. Per-file editing is the shape of the work,
   * and it falls back to the full rewrite whenever it cannot see the change
   * through.
   *
   * An attached image is the exception: the per-file calls are text-only, so an
   * edit carrying a design reference or a picture to display goes the full-
   * rewrite route, which can actually see it.
   */
  const { isReactBundle } = await import('../../tools/project/react-bundle.js')
  if (isReactBundle(html) && !image) {
    try {
      const edited = await projectFileModify(
        html, instruction, modelId, `${changeSpec ?? ''}${stockBlock ?? ''}`, dataContext, parts, onDelta, onPlan
      )
      if (edited) return edited
      logger.info('Per-file edit produced nothing — falling back to full rewrite')
    } catch (e) {
      /*
       * A refusal is not a reason to try something bigger.
       *
       * The full rewrite below is about nineteen per-file edits. When the model
       * declined the cheap call because the account is throttled or out of daily
       * tokens, answering with the most expensive call in the path cannot work,
       * and on the occasions it does it spends what little is left. The edit
       * fails instead, with a message the user can act on.
       */
      if (isModelUnavailable(e)) {
        logger.warn('Per-file edit refused; not falling back to a full rewrite', { error: String(e) })
        throw e
      }
      logger.warn('Per-file edit failed — falling back to full rewrite', { error: String(e) })
    }
  }

  // For structural instructions (adding tabs, pages, sections), always regenerate
  // the full HTML — CSS-override cannot insert new DOM elements.
  // The CSS-override path cannot insert DOM, so anything that adds a screen or a
  // control must rewrite the document however large it is. The router classifies
  // this far better than the keyword heuristic it supersedes.
  /*
   * `!dataContext` is the important half.
   *
   * A CSS override appends a stylesheet. It cannot change a single record, so an
   * edit carrying a data file has nothing to gain here and everything to lose:
   * the run would report success, the styles would be appended, and the data the
   * user attached would be exactly as absent as before.
   */
  if (html.length > 25000 && !forceFullRewrite && !dataContext && !isStructuralInstruction(instruction)) {
    logger.info('directModify: large HTML — using CSS override approach', { htmlLen: html.length })
    return cssOverrideModify(html, instruction, modelId, preset)
  }
  const rewritten = await fullHtmlModify(html, instruction, modelId, maxTokens, dataContext, preset, onDelta, onPlan, changeSpec, image, stockBlock)

  /**
   * The fallback gets the same module-layout corrections the per-file path does.
   *
   * It did not, and that is the path a React edit takes whenever per-file
   * declines — measured in real use, right after a planner returned no plan.
   * A whole-document rewrite that adds a folder cannot write the barrel for it
   * any more reliably than a per-file one can, and here nothing was fixing it
   * afterwards.
   */
  if (isReactBundle(rewritten)) {
    const { normalizeReactExtensions, addMissingBarrels } = await import('../../tools/project/react-bundle.js')
    const normalised = normalizeReactExtensions(rewritten)
    const barrelled = addMissingBarrels(normalised.html)
    if (normalised.renamed.length || barrelled.added.length) {
      logger.info('Full rewrite repaired module layout', {
        renamed: normalised.renamed,
        barrels: barrelled.added,
      })
    }
    const { repairSyntax } = await import('../repair/syntax-repair.js')
    const syntax = repairSyntax(barrelled.html)
    if (syntax.repairs.length > 0) {
      logger.info('Full rewrite repaired syntax', {
        repairs: syntax.repairs.map((r) => `${r.path}:${r.line}`),
      })
    }
    return correctIdioms(syntax.html, 'Full rewrite')
  }
  return rewritten
}

/**
 * Apply a user modification instruction to a previously generated UI.
 */
/**
 * The 「修復する」 request, with the cause the source already shows.
 *
 * The preview's repair button sends the browser's error as the instruction, and
 * the error it catches most is React #130 — 「Element type is invalid … got:
 * undefined」 — or 「x is not a function」, neither of which names the import that
 * produced it. The model then has to find a wrong import across every file from a
 * minified stack, and the note on that button records what it does instead:
 * deletes the screen that threw.
 *
 * The static check can name it, so the request carries it. Only for that
 * request — recognised by the sentence the frontend writes — and only when the
 * check finds something; any other instruction is passed through untouched.
 */
const RUNTIME_REPAIR_PREFIX = '生成されたアプリが起動時にエラーで停止しています。'

export function withStaticDiagnosis(instruction: string, html: string): string {
  if (!instruction.startsWith(RUNTIME_REPAIR_PREFIX)) return instruction
  const found = moduleDefects(html).filter((d) => d.id === 'export-missing' || d.id === 'import-missing')
  if (found.length === 0) return instruction
  return `${instruction}\n\n静的検査で、このエラーの原因と考えられる import の不整合が見つかっています:\n${found.map((d) => d.instruction).join('\n')}`
}

export async function modifyUI(options: {
  html: string
  instruction: string
  userId: string
  preset?: string
  model?: ModelChoice
  jobId?: string
  /** Raw attachment from the request; parsed here so callers pass what they received. */
  image?: string
  /**
   * Several pictures, and what the user said each one is.
   *
   * The composer used to send an edit only the first picture and clear the
   * rest, so a second photograph attached to an edit disappeared without a
   * word. They are read here the way the build reads them — see
   * supplied-images.ts — and placed by marker after the edit.
   */
  images?: string[]
  imageCaptions?: string[]
  /**
   * A data file attached to the edit — the same one a build takes.
   *
   * Threaded as its own value rather than folded into `changeSpec`, because
   * `changeSpec` is presented to the rewriter as "an interaction designer
   * specified this change" and a CSV is not that. It is also produced only when
   * the router asks for a design pass, and an edit that replaces seed data must
   * carry the data whether or not it got one.
   */
  attachment?: RawAttachment
  /**
   * The same dial the build modes set, applied to an edit.
   *
   * Carried here so a user who chose 節約 does not pay for browser verification
   * on every subsequent correction. A mode that only applied to the first
   * generation would be a setting people believe they turned on.
   */
  effort?: Effort
}): Promise<{
  html: string
  plan?: string
  /** The instruction's checklist, as numbers — see graph.ts `FinalOutput.metadata.requirements`. */
  requirements?: { total: number; met: number; unmet: number; unverified: number }
  toolsUsed: string[]
  /** The four kinds the run is billed in — see `FinalOutput.tokenUsage`. */
  tokenUsage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  /**
   * Which tier actually ran, and which design system was bound.
   *
   * Returned because the client cannot work either out for itself once `auto`
   * is in play, and the chat thread is supposed to say what produced each
   * reply. An edit carried no model information at all before this.
   */
  modelTier: 'haiku' | 'sonnet' | 'opus'
  preset: string
  /** Which stages this edit was allowed to run, for the same reason as the tier. */
  effort: Effort
  /** Absent when the page was never rendered — a missing check, not a clean one. */
  verification?: EditVerification
}> {
  // Same split as generateUI: the wrapper owns the ledger's lifetime so every
  // model call below reports into it without being handed anything.
  return withTokenLedger(async (ledger) => {
    // The running total for the progress transcript — see tokenHeartbeat.
    const heartbeat = options.jobId ? tokenHeartbeat(options.jobId, () => ledger.inputTokens + ledger.outputTokens) : null
    if (heartbeat) ledger.onRecord = heartbeat.notify
    try {
      return await runModify(options, ledger)
    } finally {
      if (heartbeat) await heartbeat.flush()
      // Written in `finally` so a failed run still says what it spent. A run
      // that dies after the design phase is exactly the one worth costing.
      logLedger(ledger, { run: 'runModify' })
    }
  })
}

async function runModify(
  options: Parameters<typeof modifyUI>[0],
  ledger: TokenLedger
): Promise<Awaited<ReturnType<typeof modifyUI>>> {
  const { html, instruction: requestedInstruction, userId, preset: requestedPreset, model, jobId } = options
  const instruction = withStaticDiagnosis(requestedInstruction, html)
  if (instruction !== requestedInstruction) {
    logger.info('Runtime repair request carries the static diagnosis', { userId })
  }
  /*
   * Rebound, not renamed at every use. A user's imported system arrives as
   * `system:<uuid>` and has to be registered before anything looks it up; every
   * line below that reads `preset` — the change designer, the conformance check
   * before and after, the drift repair — then needs no edit at all.
   */
  const preset = (await resolveUserDesignSystem(requestedPreset, userId, jobId ?? '')) ?? requestedPreset
  /*
   * Logged because the first time this ran, diagnosing it took four log queries
   * and a process of elimination: the file was attached, the API accepted it,
   * the job parsed it, and nothing anywhere said whether the directive that came
   * out of it was empty. One line here is the difference between reading the
   * answer and inferring it.
   */
  const parsedAttachment = parseAttachment(options.attachment)
  const attachmentContext = attachmentDirective(parsedAttachment)
  if (options.attachment) {
    logger.info('Edit carries a data attachment', {
      userId,
      name: options.attachment.name,
      parsed: Boolean(parsedAttachment),
      kind: parsedAttachment?.kind,
      totalRecords: parsedAttachment?.totalRecords,
      directiveChars: attachmentContext.length,
    })
  }
  if (options.image && !parseImageInput(options.image)) {
    logger.warn('Attached image could not be parsed and was dropped', { userId })
  }
  /*
   * The pictures, before anything reads the context they add to.
   *
   * Content pictures reach the edit as text — a description and a marker — so
   * they do not force the full rewrite a reference does; the per-file edit can
   * place them. Only a reference, which a model has to see, still takes the
   * rewrite route below.
   */
  const supplied = await prepareSuppliedImages({
    image: options.image,
    images: options.images,
    imageCaptions: options.imageCaptions,
    prompt: requestedInstruction,
    // Haiku, as the build captions: describing a photograph is not the task the edit's model was chosen for.
    invoke: (system, content, maxTokens) => invokeVision(
      import('../../config/agentcore-config.js').then((m) => m.getModelConfig()).then((c) => c.haikuId), system, content, maxTokens),
    onCaptioning: () => { if (jobId) updateJobStream(jobId, '', 0, '画像を確認中').catch(() => {}) },
    context: { userId, run: 'modify' },
  })
  const imageInput = supplied.reference
  /*
   * One context for everything the edit is handed besides the instruction: the
   * data file, the pictures to place, and what the user said the reference is.
   * `!dataContext` also keeps a picture edit off the stylesheet-only path, which
   * cannot place an image any more than it can change a record.
   */
  const dataContext = `${attachmentContext}${supplied.contentContext}${imageInput ? imageCaptionNote(supplied.referenceCaption) : ''}`

  const emit = (agent: string, status: 'started' | 'completed') => {
    if (jobId) appendJobEvent(jobId, agent, status).catch(() => {})
  }

  emit('routing', 'started')
  if (jobId) updateJobStream(jobId, '', 0, '変更内容を解析中').catch(() => {})
  /**
   * The mode picks the model when the mode has one, exactly as generation does.
   * This path used to read `browserVerify` from the effort profile and nothing
   * else, so a 節約 edit skipped verification and then went to the router —
   * which reads the instruction and can answer Opus. The mode said cheap and the
   * edit was not.
   *
   * The router still decides when the user picks `auto`: "make the button red"
   * and "add a whole approvals flow" are the same request shape and very
   * different amounts of work, and the instruction is the only brief an edit
   * has. The mode no longer has an opinion — it decides how much checking runs,
   * which is a separate question from which model does the work.
   */
  const selectedModel = await resolveModelForPrompt(
    model,
    instruction,
    await allowedModelsForRun(userId)
  )
  if (selectedModel.autoReason) {
    logger.info('Auto-selected model for modify', {
      userId,
      tier: selectedModel.tier,
      reason: selectedModel.autoReason,
    })
  }

  /**
   * Route the edit before doing it.
   *
   * Every instruction used to take the identical single pass, which is the wrong
   * shape at both ends: "make the button red" does not need a design phase, and
   * "add a category screen" very much does — that one shipped broken often
   * enough to be the running complaint about edits. The router decides which of
   * the two this is.
   */
  /* Classification, so the cheapest model — see routerModelId in graph.ts. */
  const routerModel = (await (await import('../../config/agentcore-config.js')).getModelConfig()).haikuId
  /*
   * The instruction as a checklist, started alongside the router.
   *
   * An edit was reported as applied when a FILE WAS WRITTEN — `describeEditOutcome`
   * counts writes, not changes — so 「ラベルを『予約を確定する』に変えて」 whose
   * label never changed came back as 「変更を適用しました」. This is what lets the
   * reply say whether the change is actually in the project.
   */
  // From what the user asked, not from the diagnosis appended to it: file paths
  // and import names are not requirements the reply should report on.
  const editRequirementsPromise = extractRequirements(requestedInstruction)
  const routePlan = await planModifyWorkflow(instruction, routerModel, summariseDocument(html))
  /*
   * The decomposition, logged for the same reason the attachment is: a run
   * whose four parts all landed says nothing about whether they were carried as
   * four parts or as one sentence that happened to work. Without this the only
   * way to tell is to infer it from the file plan.
   */
  if (routePlan.parts.length > 1) {
    logger.info('Edit request decomposed', {
      userId,
      parts: routePlan.parts.map((p) => `${p.scope}: ${p.text.slice(0, 60)}`),
    })
  }
  logger.info('Edit routed', {
    userId,
    scope: routePlan.scope,
    needsDesignPass: routePlan.needsDesignPass,
    routed: routePlan.routed,
    reason: routePlan.reason,
  })
  emit('routing', 'completed')

  /**
   * Spec the change before building it, for edits that add screens or behaviour.
   *
   * Reuses the interaction designer from the generation graph, so a screen added
   * by an edit is held to the same contract as one built at generation time:
   * every control enumerated, every state write named, reverse paths included.
   */
  /*
   * What the project says about itself, for the requests that need it — see
   * change-diagnosis.ts.
   *
   * Asked 「画像が出てないんだけどどうすべき？」, this path's designer returned
   * questions and its file planner decided "a question, not a change", named no
   * files, and the run fell back to rewriting the whole document — the stage
   * that is 35% of all edit tokens over thirty days, at about 58k each time it
   * fires. Measured only for a problem report or a request about pictures, so
   * an ordinary edit pays nothing for it.
   *
   * Kept out of `dataContext` on purpose: that string being empty is what keeps
   * a pure style edit on the stylesheet-only path, and facts in it would take
   * every edit off that path and cost more than they save.
   */
  const diagnosis = diagnoseForChange(html, instruction)
  // And an element picked on screen, which the planner could not map to a file
  // either: 2 of the 6 declines in thirty days were 「Target element: header. …」.
  const facts = diagnosis.problemReport || diagnosis.aboutImages || diagnosis.targeted ? diagnosis.text : ''
  if (facts) {
    logger.info('Change diagnosed from the source', {
      userId,
      chars: facts.length,
      problemReport: diagnosis.problemReport,
      aboutImages: diagnosis.aboutImages,
      targeted: diagnosis.targeted,
    })
  }

  let changeSpec = ''
  if (routePlan.needsDesignPass) {
    emit('change-design', 'started')
    if (jobId) updateJobStream(jobId, '', 0, '変更の設計中').catch(() => {})
    try {
      const { specifyChange } = await import('../generate/strands-design.js')
      changeSpec = await specifyChange({
        instruction,
        html,
        presetName: preset,
        presetSpec: preset && preset !== 'none' ? getPresetSpec(preset) : '',
        modelId: selectedModel.modelId,
        image: imageInput,
        dataContext,
        facts,
        onDelta: (full) => { if (jobId) updateJobStream(jobId, full, full.length, '変更の設計中').catch(() => {}) },
      })
      logger.info('Change specification produced', { userId, chars: changeSpec.length })
    } catch (e) {
      // A missing spec makes the edit weaker, never impossible.
      logger.warn('Change specification failed; editing without it', { userId, error: String(e) })
    }
    emit('change-design', 'completed')
  }

  /**
   * Photographs offered to the edit, when the edit is plausibly about imagery.
   *
   * Edits could not add a real picture at all: the library was wired into
   * generation only, so "商品の写真を入れて" was answered with a grey box or an
   * invented URL that 404s. Two gates rather than one, because the failure runs
   * both ways — offering photographs to "make the button red" is how a model
   * decides the button needs a photograph next to it.
   */
  const wantsImagery = /写真|画像|フォト|イメージ|photo|image|picture/i.test(instruction)
  let stockBlock = ''
  /** Kept for the invented-URL repair, which substitutes out of this list. */
  let offeredImages: Awaited<ReturnType<typeof pickStockImages>> = []
  if (wantsImagery || routePlan.needsDesignPass) {
    // The document supplies the domain vocabulary the instruction usually omits:
    // "写真を追加して" names no industry, and the page it is editing does.
    const picked = await pickStockImages(
      `${instruction} ${summariseDocument(html)}`,
      wantsImagery ? 4 : 2,
      { anyCategory: wantsImagery }
    )
    offeredImages = picked
    stockBlock = stockImageInstructions(picked)
    if (picked.length > 0) {
      logger.info('Offering stock photographs to the edit', {
        userId,
        count: picked.length,
        explicit: wantsImagery,
      })
    }
  }

  emit('modifying', 'started')
  try {
    // A full-document rewrite of a real page runs 25-32k output tokens. The old
    // 8k cap for Haiku dated from Haiku 3 and made every structural edit truncate
    // mid-document, which surfaced to the user as "変更を適用できませんでした".
    // Haiku 4.5 supports the same 64k output budget generation already uses.
    const modifyMaxTokens = 64000

    // Throttled stream writes, so a long edit costs a handful of DynamoDB updates.
    let lastWrite = 0
    let inFlight = false
    const onDelta = jobId
      ? (full: string) => {
          const now = Date.now()
          if (inFlight || now - lastWrite < STREAM_FLUSH_MS) return
          lastWrite = now
          inFlight = true
          updateJobStream(jobId, full, full.length, '変更を適用中')
            .catch(() => {})
            .finally(() => { inFlight = false })
        }
      : undefined

    let plan = ''
    // The facts go ahead of the spec: the file planner reads the first 12,000
    // characters of it, and a diagnosis cut off at the end is no diagnosis.
    const specWithFacts = `${facts}${changeSpec ? `\n\n${changeSpec}` : ''}`.trim()
    let modifiedHtml = await directModify(html, instruction, selectedModel.modelId, modifyMaxTokens, dataContext, routePlan.parts, preset, onDelta, (p) => { plan = p }, specWithFacts || undefined, routePlan.needsDesignPass, imageInput, stockBlock || undefined)
    if (jobId) await updateJobStream(jobId, modifiedHtml, modifiedHtml.length, '変更を適用中').catch(() => {})
    emit('modifying', 'completed')

    /**
     * Hold edits to the same bar as generation.
     *
     * Generation gained a quality audit, but every edit went straight out
     * unchecked — so a page could be built clean and then have emoji, gradient
     * headlines or the default indigo palette reintroduced by any subsequent
     * instruction. Only defects the edit *introduced* are repaired: pre-existing
     * ones are the user's document, not this edit's doing.
     */
    /**
     * Read from the document rather than from what was asked for: an edit is
     * given a project and returns one, and the framework is whatever the files
     * say it is.
     */
    const outputKind: OutputKind = detectKind(readProjectFiles(modifiedHtml).keys()) ?? DEFAULT_OUTPUT_KIND
    const before = new Set(auditAiTells(html, preset, outputKind).map((d) => d.id))
    const introduced = auditAiTells(modifiedHtml, preset, outputKind).filter((d) => !before.has(d.id))

    /**
     * A module the edit imported and did not write.
     *
     * The per-file path reverts the importer, which is safe but silent — the
     * user's change simply does not happen. The whole-document path cannot
     * revert anything, so before this it shipped, and the user saw
     * `Module not found: './screens/ContactScreen'` and a blank page.
     *
     * Naming it as a defect sends it to the repair with the one instruction
     * that fixes it: write the missing file. Measured as a delta, because a
     * document that arrived with a broken import is not this edit's doing.
     */
    /**
     * Every project format, not only React.
     *
     * `moduleDefects` resolves imports through the framework's own source
     * extensions, so gating it here meant a Vue or Svelte edit that imported a
     * component it forgot to write shipped with the import intact — and an
     * unresolved import is not a degraded module, it is the end of the program.
     */
    {
      const { moduleDefects } = await import('../../tools/project/react-bundle.js')
      const had = new Set(moduleDefects(html).map((d) => d.id))
      introduced.push(...moduleDefects(modifiedHtml).filter((d) => !had.has(d.id)))
    }

    // Preset drift is measured as a delta too: an edit may only make conformance
    // worse, never be blamed for what the document arrived with.
    if (preset && preset !== 'none') {
      const was = presetConformance(html, preset)
      const now = presetConformance(modifiedHtml, preset)
      if (now.ratio < was.ratio || now.violations > was.violations) {
        introduced.push({
          id: 'preset-drift',
          instruction:
            `この編集でデザインシステム「${preset}」からの逸脱が生じました。` +
            (now.missing.length ? `次の値が失われています: ${now.missing.join(', ')}。` : '') +
            'システムが定義する色・フォント・角丸・影のみを使うように直してください。',
        })
      }
    }

    /**
     * Render the edited document, for the edits that can break it.
     *
     * This is where runtime verification earns the most. A measured edit that
     * added a Gantt screen reported success — `changed: true`, zero static
     * defects, nothing to repair — and shipped a chart container that was an
     * empty box. Nothing readable from the source says the screen's whole
     * subject is missing.
     *
     * Only structural and behavioural edits pay for it: a colour change cannot
     * introduce an empty screen, and a browser session per wording tweak would
     * be latency spent on nothing. Measured as a delta like everything else here
     * — the document the user brought is not this edit's fault.
     */
    /** Runtime defect ids the document already had, so the repair is judged on the delta. */
    let runtimeBaseline: Set<string> | null = null
    /**
     * The render of the edited document as it stood before the repair pass, so
     * the repair can be judged on what it changed rather than only on absolute
     * thresholds a regression can slip under.
     */
    let editedFacts: Awaited<ReturnType<typeof import('../../tools/browser/browser-verify.js').verifyInBrowser>> = null
    /** What the browser measured on the edited document, for the client to show. */
    let verification: EditVerification | undefined
    /**
     * The render of the repaired document, so the numbers shown to the user
     * describe the document they are looking at.
     *
     * Without this the badge reports the pre-repair measurements even when the
     * repair was accepted — the same "measurements of a document that was thrown
     * away" bug the generation path carries `scoredFacts` to avoid. It was fixed
     * there and not here, which is how a fix stops at one of two call sites.
     */
    let repairedFacts: Awaited<ReturnType<typeof import('../../tools/browser/browser-verify.js').verifyInBrowser>> = null
    if (BROWSER_VERIFY_ENABLED && effortProfile(options.effort).browserVerify && routePlan.needsDesignPass) {
      emit('browser-verify', 'started')
      if (jobId) updateJobStream(jobId, '', 0, 'ブラウザで実際に表示して検証中').catch(() => {})
      try {
        const { verifyInBrowser } = await import('../../tools/browser/browser-verify.js')
        const { auditRuntime } = await import('../audit/runtime-audit.js')
        const { isReactBundle } = await import('../../tools/project/react-bundle.js')
        const { declaredScreenIds } = await import('../audit/interaction-audit.js')
        /**
         * Same contract as the generation path: a React project's screens live
         * in routes.ts and never reach the DOM, so the list of what should be
         * reachable has to be handed to the verifier.
         */
        const verify = (doc: string) =>
          verifyInBrowser(doc, { declaredScreens: declaredScreenIds(doc) })
        const [wasFacts, initialFacts] = await Promise.all([verify(html), verify(modifiedHtml)])
        let nowFacts = initialFacts
        /**
         * Fill holes here rather than leaving them to the repair pass.
         *
         * Measured on this exact case: an edit added a Gantt screen whose chart
         * rendered as an empty box, the repair pass was handed the defect,
         * fixed an unrelated preset drift instead, and was accepted for that —
         * shipping the empty chart. The repair is told not to change existing
         * markup or design, so it cannot be the thing that authors a chart.
         */
        /**
         * Only holes this edit created.
         *
         * The first version filled any hole in the document, which quietly broke
         * the rule the rest of this function follows: pre-existing defects are
         * the user's document, not this edit's doing. Under it, "make the button
         * red" could rewrite a chart the user never mentioned. Measured as a
         * delta like everything else here.
         */
        const holesWere = wasFacts
          ? wasFacts.screens.reduce((n, sc) => n + sc.emptyBoxes.length, 0)
          : 0
        const holesNow = nowFacts
          ? nowFacts.screens.reduce((n, sc) => n + sc.emptyBoxes.length, 0)
          : 0
        // HTML only, for the reason given on the generation path: the pass finds
        // its target by matching the rendered opening tag against the source, and
        // a React project's source is TSX — `class` in the DOM, `className` in the
        // file. It would never locate anything. React holes go to the repair pass.
        if (nowFacts && holesNow > holesWere && !isReactBundle(modifiedHtml)) {
          const holesBefore = holesNow
          const { fillEmptyContainers } = await import('../repair/fill-empty.js')
          const attempt = await fillEmptyContainers(
            modifiedHtml,
            nowFacts,
            preset && preset !== 'none' ? getPresetSpec(preset) : '',
            (system, user) => invokeText(selectedModel.modelId, system, user, 8000, 'edit:fill-empty')
          )
          if (attempt.filled.length > 0) {
            const refacts = await verify(attempt.html)
            const holesAfter = refacts ? refacts.screens.reduce((n, sc) => n + sc.emptyBoxes.length, 0) : holesBefore
            if (refacts && holesAfter < holesBefore) {
              modifiedHtml = attempt.html
              nowFacts = refacts
              logger.info('Empty container fill accepted', { userId, holesBefore, holesAfter, filled: attempt.filled })
            } else {
              logger.info('Empty container fill rejected — no measured improvement', { userId, holesBefore, holesAfter })
            }
          }
        }

        editedFacts = nowFacts
        if (nowFacts) {
          verification = {
            screens: nowFacts.screens.map((x) => ({ id: x.id, fill: Math.round(x.fill * 100) / 100 })),
            emptyBoxes: nowFacts.screens.reduce((n, x) => n + x.emptyBoxes.length, 0),
            consoleErrors: nowFacts.consoleErrors.length,
            deadNav: nowFacts.deadNav.length,
            deadActions: nowFacts.deadActions.length,
            smallFields: nowFacts.smallFields.length,
            unreachable: nowFacts.unreachable,
            contrast: nowFacts.contrast.map((c) => ({ text: c.text, ratio: c.ratio, required: c.required })),
            mobileOverflowPx: nowFacts.mobile?.overflowBy ?? 0,
          }
          /*
           * With the bound preset, so an edit that moves the shell off the design
           * system is seen — and kept out of the repair, as generation keeps it out:
           * rebuilding a working app's navigation is the restructure that broke it
           * three times in six (REPORT_ONLY in repair-yield.ts). It is logged, so
           * how often edits do this can be counted.
           */
          const had = new Set(wasFacts ? auditRuntime(wasFacts, html, preset).map((d) => d.id) : [])
          const found = auditRuntime(nowFacts, modifiedHtml, preset).filter((d) => !had.has(d.id))
          const reportOnly = found.filter((d) => !repairable(d.id))
          if (reportOnly.length > 0) {
            logger.info('Edit introduced defects that are reported, not repaired', { userId, preset, defects: reportOnly.map((d) => d.id) })
          }
          const newly = found.filter((d) => repairable(d.id))
          if (newly.length > 0) {
            logger.info('Edit introduced runtime defects', { userId, defects: newly.map((d) => d.id) })
            introduced.push(...newly)
            runtimeBaseline = had
          }
        }
      } catch (e) {
        logger.warn('Browser verification of edit failed', { userId, error: String(e) })
      }
      emit('browser-verify', 'completed')
    }

    /*
     * The instruction itself, checked before the repair rather than after it.
     *
     * The checklist used to be read only for the reply, so an edit that missed a
     * requirement could say so and do nothing about it. Measured on the
     * verification edit: 「フッターに『開館時間 9:00〜19:00』と表示」 landed inside
     * the one screen the rest of the instruction named, and the reply called it
     * done. A miss the source can prove is exactly the kind of defect the repair
     * below exists for, and it costs one per-file call instead of a user's second
     * request.
     *
     * Bounded like the generation's, and fail-open: no checklist, no defects.
     */
    const editRequirements = await Promise.race([
      editRequirementsPromise,
      new Promise<Awaited<typeof editRequirementsPromise>>((resolve) => setTimeout(() => resolve([]), 20_000)),
    ])
    const requirementMisses = requirementDefects(checkRequirements(modifiedHtml, editRequirements))
    if (requirementMisses.length > 0) {
      logger.info('Edit missed requirements; sending them to the repair', {
        userId,
        misses: requirementMisses.map((d) => (d.note ?? d.id).slice(0, 80)),
      })
      introduced.push(...requirementMisses)
    }

    if (introduced.length > 0) {
      emit('quality-repair', 'started')
      logger.info('Edit introduced quality defects', { userId, defects: introduced.map((d) => d.id) })
      try {
        const repaired = await directModify(
          modifiedHtml,
          // A defect that knows its files says so: the per-file planner behind
          // this call reads file names, and 「src/App.tsx に置く」 is not a guess.
          `次の点だけを修正してください。それ以外の内容・構造・デザインは一切変更しないでください:\n${introduced.map((d, i) => `${i + 1}. ${d.instruction}${d.paths?.length ? `（対象ファイル: ${d.paths.join(', ')}）` : ''}`).join('\n')}`,
          selectedModel.modelId,
          modifyMaxTokens,
          // Deliberately none. This call says "change only these points and
          // nothing else"; handing it the user's data would invite it to
          // rewrite records it was not asked to touch.
          '',
          // And one part, for the same reason: this call's instruction IS the
          // whole of what it may do.
          [{ text: '検出された品質上の問題の修正' }],
          preset,
          onDelta,
        )
        const after = auditAiTells(repaired, preset, outputKind).filter((d) => !before.has(d.id))
        // Measured again with the same list, so a repair is credited for a
        // requirement only when the source now shows it.
        after.push(...requirementDefects(checkRequirements(repaired, editRequirements)))
        if (preset && preset !== 'none' && presetConformance(repaired, preset).ratio < presetConformance(html, preset).ratio) {
          after.push({ id: 'preset-drift', instruction: '' })
        }
        /**
         * Runtime defects cannot be re-derived from the source, so the repaired
         * document is rendered again. Skipping this would compare a mixed
         * "before" against a static-only "after" and accept the repair in
         * proportion to how many browser defects it was handed — accepting it
         * most readily exactly where it was verified least.
         */
        if (runtimeBaseline) {
          const { verifyInBrowser } = await import('../../tools/browser/browser-verify.js')
          const { auditRuntime } = await import('../audit/runtime-audit.js')
          const { declaredScreenIds } = await import('../audit/interaction-audit.js')
          const facts = await verifyInBrowser(
            repaired,
            { declaredScreens: declaredScreenIds(repaired) }
          )
          // Unavailable now though it worked a moment ago: carry the complaints
          // forward rather than counting them as fixed.
          const { runtimeRegressions } = await import('../audit/runtime-audit.js')
          after.push(
            ...(facts
              ? [
                  ...auditRuntime(facts, repaired, preset).filter((d) => !runtimeBaseline!.has(d.id) && repairable(d.id)),
                  // Whatever this repair made worse, judged against the render
                  // taken of the edited document before it ran.
                  ...(editedFacts ? runtimeRegressions(editedFacts, facts) : []),
                ]
              : introduced.filter((d) => /^(blank-render|console-error|screen-thin|empty-container|nav-dead-runtime|action-dead-runtime|input-small|screen-unreachable)$/.test(d.id)))
          )
          repairedFacts = facts
        }
        /*
         * And a repair that stops the project building is never kept.
         *
         * A wording edit renders nothing — the browser pass above is only for
         * structural and behavioural edits — so a requirement repair on one was
         * judged by the static audits and the checklist alone. Both read source
         * text, and a file that no longer parses has fewer patterns for them to
         * complain about: it measures as an improvement. The generation path
         * compiles every candidate before judging it; this is the same gate, in
         * milliseconds and without a model call.
         */
        const { toRunnableDocument } = await import('../../tools/project/react-bundle.js')
        const brokeBuild = Boolean(toRunnableDocument(repaired).error) && !toRunnableDocument(modifiedHtml).error
        if (brokeBuild) {
          logger.info('Edit quality repair rejected — the project no longer builds', {
            userId,
            error: String(toRunnableDocument(repaired).error).slice(0, 300),
          })
        }
        // Same rule as the generation passes: keep it only if it measurably improved.
        if (!brokeBuild && after.length < introduced.length) {
          modifiedHtml = repaired
          if (repairedFacts) {
            verification = {
              screens: repairedFacts.screens.map((x) => ({ id: x.id, fill: Math.round(x.fill * 100) / 100 })),
              emptyBoxes: repairedFacts.screens.reduce((n, x) => n + x.emptyBoxes.length, 0),
              consoleErrors: repairedFacts.consoleErrors.length,
              deadNav: repairedFacts.deadNav.length,
              deadActions: repairedFacts.deadActions.length,
              smallFields: repairedFacts.smallFields.length,
              unreachable: repairedFacts.unreachable,
              contrast: repairedFacts.contrast.map((c) => ({ text: c.text, ratio: c.ratio, required: c.required })),
              mobileOverflowPx: repairedFacts.mobile?.overflowBy ?? 0,
            }
          }
          logger.info('Edit quality repair accepted', { userId, before: introduced.length, after: after.length })
        } else if (!brokeBuild) {
          logger.info('Edit quality repair rejected — no improvement', { userId })
        }
      } catch (e) {
        logger.warn('Edit quality repair failed', { userId, error: String(e) })
      }
      emit('quality-repair', 'completed')
    }

    /**
     * Invented photograph URLs, swapped for real ones.
     *
     * A model handed three URLs will write a fourth, and a 404 is invisible to
     * every other check here — the DOM has an <img>, the layout is intact, and
     * only a human looking at the page sees the broken icon. Unconditional
     * because an edit can invent a URL whether or not this edit was offered any;
     * it is a no-op on a document that mentions none.
     */
    const stockFixed = await repairStockUrls(modifiedHtml, offeredImages)
    if (stockFixed.fixed > 0) {
      modifiedHtml = stockFixed.html
      logger.info('Replaced invented photograph URLs in edit', { userId, count: stockFixed.fixed })
    }

    /**
     * And every photograph reassigned to match what it illustrates.
     *
     * The same pass generation runs, for the same reason and with the same
     * limits: it only moves URLs under our own stock path, so an image the user
     * attached or an illustration the pipeline drew is left alone. An edit that
     * adds a product to a catalogue is exactly as likely to put an office desk
     * on it as the original build was.
     */
    const assigned = await assignItemImages(modifiedHtml, {
      brief: instruction,
      resolveNames: resolveSubjects,
    })
    if (assigned.assignments.length > 0) {
      modifiedHtml = assigned.html
      logger.info('Photographs matched to their subjects in edit', {
        userId,
        matched: assigned.matched,
        cleared: assigned.cleared,
      })
    }

    logger.info('Token usage: modifyUI', {
      inputTokens: ledger.inputTokens,
      outputTokens: ledger.outputTokens,
      calls: ledger.calls,
      unreported: ledger.unreported,
      effort: options.effort ?? 'checked',
    })

    // Substituted last, for the same reason generation does it last: the repair pass
    // above rewrites the whole document, and a data URI put in earlier would be
    // re-transcribed by a model or cut off by its input truncation.
    if (imageInput && isEmbeddable(imageInput)) {
      const embedded = embedUserImage(modifiedHtml, imageInput)
      modifiedHtml = embedded.html
      logger.info('User image embedded into edit', { userId, placements: embedded.count })
    }
    // The placed pictures, last for the same reason, and any marker left standing removed.
    if (supplied.placeable.length > 0) {
      const placed = embedContentImages(modifiedHtml, supplied.placeable)
      modifiedHtml = placed.html
      const unplaced = supplied.placeable.filter((_im, i) => placed.placements[i] === 0).map((im) => im.index)
      logger.info('Supplied images embedded into edit', { userId, placements: placed.placements, unplaced })
    }
    {
      const stripped = stripContentImageTokens(modifiedHtml)
      if (stripped.stripped.length > 0) {
        logger.warn('Unsubstituted image markers stripped from edit', { userId, markers: stripped.stripped })
        modifiedHtml = stripped.html
      }
    }

    /*
     * The design system's token block, put back if the edit rewrote the stylesheet
     * without it. Only on a document the edit changed: a project built before the
     * block existed gets it with its next real edit, not from a reply that changed
     * nothing, which would otherwise report itself as a change.
     */
    if (modifiedHtml !== html) {
      const founded = applyPresetFoundation(modifiedHtml, preset)
      if (founded.applied) {
        modifiedHtml = founded.html
        logger.info('Edit carries the design system token block', { userId, preset, overridden: founded.overridden.length })
      }
    }

    logger.info('UI modification completed', {
      userId,
      instruction: instruction.slice(0, 100),
      changed: modifiedHtml !== html,
    })

    /*
     * The chat message for this edit.
     *
     * `plan` is whatever the run last reported, and for the per-file path that
     * is the planner's file list — 「新規 src/screens/ContactScreen.tsx — new
     * contact form screen with validation」 and four more like it, in English,
     * in a Japanese thread. Twelve of forty-five stored replies were exactly
     * that: true, and about the machine rather than about what changed.
     *
     * It still goes to `onDelta`, so the activity card keeps showing which files
     * are being touched while the edit runs. What changes is only what is left
     * standing as the answer once it has finished.
     */
    /*
     * And the scaffolding, which this path was never stripping.
     *
     * `replyText` takes the transported files out AND the worksheet the model
     * was asked to write for itself — 「**Step 0 — 設計委譲前の確認**」 and the
     * trailing rule under it. The generate path has run everything through it
     * since it was written; this one stopped at `stripTransportedFiles`, so an
     * edit whose reply happened to be prose was shown exactly as the model
     * wrote it, worksheet and all.
     *
     * `conciseDescription` is deliberately NOT applied. On the generate side it
     * cuts a 1,597-character design essay down to what was built; an edit reply
     * is already one or two sentences about one change, and taking its first
     * three sentences would start dropping half of a two-part answer.
     */
    /*
     * Whether the change is in the project, not whether a file was written.
     *
     * Only the mechanically checkable parts of the instruction are asserted — a
     * label that must now read a certain way, text that must be gone, a key that
     * must be handled, a screen that must exist. What cannot be checked is left
     * unsaid rather than claimed. Checked on the document that ships, after the
     * repair above had its chance at any miss.
     */
    const editChecks: RequirementResult[] = checkRequirements(modifiedHtml, editRequirements)
    const notLanded = editChecks.filter((r) => r.status === 'unmet')
    if (editChecks.length > 0) {
      logger.info('Edit requirements checked', {
        total: editChecks.length,
        met: editChecks.filter((r) => r.status === 'met').length,
        unmet: notLanded.length,
        unverified: editChecks.filter((r) => r.status === 'unverified').length,
        unmetKinds: notLanded.map((r) => r.requirement.check.kind),
        misplaced: notLanded.filter((r) => r.reason === 'misplaced').length,
        repairedMisses: requirementMisses.length - notLanded.length,
      })
    }
    const reply = describeEditReply(plan, routePlan.parts, instruction, editChecks)
    const editSummary = summarizeRequirements(editChecks)

    return {
      html: modifiedHtml,
      plan: reply,
      ...(editSummary.total > 0
        ? { requirements: { total: editSummary.total, met: editSummary.met, unmet: editSummary.unmet, unverified: editSummary.unverified } }
        : {}),
      toolsUsed: [],
      tokenUsage: { inputTokens: ledger.inputTokens, outputTokens: ledger.outputTokens, cacheReadTokens: ledger.cacheReadTokens, cacheWriteTokens: ledger.cacheWriteTokens },
      modelTier: selectedModel.tier,
      preset: preset || 'none',
      effort: options.effort ?? 'checked',
      verification,
    }
  } catch (e: any) {
    emit('modifying', 'completed')
    logger.error('modifyUI failed', { userId, error: e?.message })
    // Pass our own diagnostics through; only mask unexpected internals.
    throw new Error(
      typeof e?.message === 'string' && /切れました|応答がありません/.test(e.message)
        ? e.message
        : '変更の適用に失敗しました。もう一度お試しください。'
    )
  }
}
