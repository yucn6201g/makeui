/**
 * Calling Bedrock: streaming and plain completions, vision, and the fallback to
 * the next model down when the account cannot invoke the one asked for.
 */
import { InvokeModelCommand, InvokeModelWithResponseStreamCommand } from '@aws-sdk/client-bedrock-runtime'
import { nextModelDown } from '../../config/model-config.js'
import { createBedrockClient } from '../../config/bedrock-client.js'
import { recordTokens, recordUnreportedCall } from '../../services/token-ledger.js'
import { systemField, type SystemPrompt } from '../prompts/prompt-cache.js'
import { logger } from '../../utils/logger.js'
import { userContentWithImage, type ImageInput } from '../../utils/image-input.js'

// Loaded on demand: pulls in the Strands SDK, which the Lambda fallback path never needs.
export const getRunDesignSwarm = () => import('./strands-design.js').then((m) => m.runDesignSwarm)

/** Minimum gap between in-flight stream writes to DynamoDB; the generate, plan and edit paths share it. */
export const STREAM_FLUSH_MS = 900

/**
 * Remove markdown code fences wherever they appear.
 *
 * Stripping only at position 0 stopped working once the model began writing a
 * plan before the document: the fence then sits mid-text, so it survived into the
 * plan shown in the chat.
 */
export function stripFences(text: string): string {
  return text
    .replace(/^[ 	]*```[a-zA-Z]*[ 	]*$/gm, '')   // fence on its own line
    .replace(/```[a-zA-Z]*/g, '')                   // any stragglers
    .trim()
}

export const bedrockClient = createBedrockClient()

/**
 * Model ids this container has proved it cannot invoke, and what it used instead.
 *
 * A run picks one model and then makes about thirty-five calls with it. When the
 * account cannot invoke that model, the first of those throws
 * `AccessDeniedException` and the whole generation ends with nothing — which is
 * what 思考モード does today, because it asks for Opus and no Opus this account
 * can reach is permitted to the runtime role.
 *
 * Retrying does not help and neither does waiting: the answer is identical every
 * time, which is exactly why `failure-message.ts` refuses to suggest a retry for
 * this class. The only useful response is to build the UI on the next model down
 * and say so.
 *
 * The map is per-container rather than per-run because the fact is not about the
 * run. A model the ACCOUNT cannot invoke is unusable for every request that
 * container serves, and re-learning it costs each of them a failed call.
 *
 * It is deliberately not seeded from configuration. A guessed list goes stale in
 * the quiet direction — it would have to be edited on the day access is granted,
 * by someone who has no reason to look here — whereas a list learned from the
 * refusal is empty exactly when there is nothing to avoid.
 */
const unusableModels = new Map<string, string>()

/** Whether a run's chosen model was swapped out, so the metadata can report it. */
export function modelSubstitution(modelId: string): string | undefined {
  return unusableModels.get(modelId)
}

/** Bedrock refusing the model itself, as opposed to refusing this request. */
export function isModelRefusal(e: unknown): boolean {
  const name = (e as { name?: string })?.name ?? ''
  const message = e instanceof Error ? e.message : String(e)
  return (
    (name === 'AccessDeniedException' || /AccessDeniedException/.test(message)) &&
    /model|inference.profile/i.test(message)
  )
}

/**
 * Run a Bedrock call, and if the model itself is refused, run it again on the
 * next model down.
 *
 * Both invoke paths go through here so the streaming one cannot be forgotten —
 * it is the single call that assembles the whole document, so a fallback that
 * covered only the non-streaming path would recover every step of a run except
 * the one that produces the UI.
 *
 * One step, not a ladder. Two refusals in a row means something is wrong with
 * the configuration rather than with one model, and quietly walking down to
 * Haiku would answer 思考モード with the cheapest thing in the building.
 */
export async function withModelFallback<T>(
  modelId: string,
  where: string,
  call: (id: string) => Promise<T>
): Promise<T> {
  const known = unusableModels.get(modelId)
  if (known) return call(known)
  try {
    return await call(modelId)
  } catch (e) {
    if (!isModelRefusal(e)) throw e
    const down = await nextModelDown(modelId)
    if (!down) throw e
    unusableModels.set(modelId, down)
    logger.warn('The chosen model cannot be invoked; the run continues on the next one down', {
      modelId,
      using: down,
      where,
      error: e instanceof Error ? e.message : String(e),
    })
    return call(down)
  }
}

/**
 * Same contract as invokeModel, but consumes the response as a stream and reports
 * the text as it arrives. Used for the long code-assembler step so the client can
 * show the response being written instead of a spinner.
 *
 * onDelta is throttled by the caller — it is not called per token.
 */
export async function invokeModelStreaming(
  modelId: string,
  systemPrompt: string | SystemPrompt,
  userMessage: string,
  onDelta: (fullText: string) => void,
  maxTokens = 64000,
  image: ImageInput | null = null,
  /**
   * Which stage is spending this.
   *
   * Defaulted rather than required so no call site is forced to be updated in
   * the same change, and every one that is not shows up in the ledger under
   * `unattributed` — which is a gap you can see and act on, unlike the single
   * total this replaces.
   */
  where = 'unattributed'
): Promise<string> {
  const response = await withModelFallback(modelId, where, (id) =>
    bedrockClient.send(new InvokeModelWithResponseStreamCommand({
      modelId: id,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: maxTokens,
        system: systemField(systemPrompt),
        messages: [{ role: 'user', content: userContentWithImage(userMessage, image) }],
      }),
    })))

  let text = ''
  let stopReason: string | undefined
  /**
   * Usage arrives in two places on a stream: the input count with
   * `message_start`, the output count with the final `message_delta`. Reading
   * only one of them is how a streamed call ends up billed at zero.
   */
  let cacheRead = 0
  let cacheWrite = 0
  let inputTokens = 0
  let outputTokens = 0
  for await (const event of response.body ?? []) {
    const bytes = event.chunk?.bytes
    if (!bytes) continue
    let payload: any
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      continue
    }
    if (payload.type === 'message_start') {
      inputTokens = payload.message?.usage?.input_tokens ?? 0
      outputTokens = payload.message?.usage?.output_tokens ?? 0
      cacheRead = payload.message?.usage?.cache_read_input_tokens ?? 0
      cacheWrite = payload.message?.usage?.cache_creation_input_tokens ?? 0
    } else if (payload.type === 'content_block_delta' && typeof payload.delta?.text === 'string') {
      text += payload.delta.text
      onDelta(text)
    } else if (payload.type === 'message_delta') {
      if (payload.delta?.stop_reason) stopReason = payload.delta.stop_reason
      if (typeof payload.usage?.output_tokens === 'number') outputTokens = payload.usage.output_tokens
    }
  }

  if (inputTokens || outputTokens) recordTokens(inputTokens, outputTokens, where, { read: cacheRead, write: cacheWrite })
  else recordUnreportedCall(`invokeModelStreaming:${where}`)

  if (stopReason === 'max_tokens' && text) {
    logger.warn('Model output truncated at max_tokens, using partial output', { modelId, outputLength: text.length })
  }
  return text
}

export async function invokeModel(
  modelId: string,
  systemPrompt: string | SystemPrompt,
  userMessage: string,
  maxTokens = 64000,
  image: ImageInput | null = null,
  where = 'unattributed'
): Promise<string> {
  const response = await withModelFallback(modelId, where, (id) =>
    bedrockClient.send(new InvokeModelCommand({
      modelId: id,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: maxTokens,
        system: systemField(systemPrompt),
        messages: [{ role: 'user', content: userContentWithImage(userMessage, image) }],
      }),
    })))
  const body = JSON.parse(new TextDecoder().decode(response.body))
  const text = body.content?.[0]?.text ?? ''
  if (typeof body.usage?.input_tokens === 'number') {
    recordTokens(body.usage.input_tokens, body.usage.output_tokens ?? 0, where, {
      read: body.usage.cache_read_input_tokens ?? 0,
      write: body.usage.cache_creation_input_tokens ?? 0,
    })
  } else {
    recordUnreportedCall(`invokeModel:${where}`)
  }
  if (body.stop_reason === 'max_tokens' && text) {
    logger.warn('Model output truncated at max_tokens, using partial output', { modelId, outputLength: text.length })
  }
  return text
}

/**
 * The same call, for the one stage that sends more than one image.
 *
 * `invokeModel` takes a single `ImageInput` and builds its content through
 * `userContentWithImage`, which is the right shape for the reference image and
 * cannot express several. Rather than widen a signature every other call site
 * uses, this takes the content blocks already assembled.
 *
 * Its only caller is the captioner. Everything else in the pipeline reads the
 * captions rather than the pictures — see `utils/content-images.ts` — so if a
 * second caller ever appears here, the question to ask first is whether it
 * really needs to look.
 *
 * The usage recording is a copy of `invokeModel`'s deliberately: a call that
 * reports nothing is spend nobody can see, and this file has already paid for
 * that lesson four times over.
 */
export async function invokeVision(
  modelId: string,
  systemPrompt: string,
  content: Array<Record<string, unknown>>,
  maxTokens: number,
  where: string
): Promise<string> {
  const response = await withModelFallback(modelId, where, (id) =>
    bedrockClient.send(new InvokeModelCommand({
      modelId: id,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content }],
      }),
    })))
  const body = JSON.parse(new TextDecoder().decode(response.body))
  if (typeof body.usage?.input_tokens === 'number') {
    recordTokens(body.usage.input_tokens, body.usage.output_tokens ?? 0, where, {
      read: body.usage.cache_read_input_tokens ?? 0,
      write: body.usage.cache_creation_input_tokens ?? 0,
    })
  } else {
    recordUnreportedCall(`invokeVision:${where}`)
  }
  return body.content?.[0]?.text ?? ''
}

/**
 * The routers run on the cheapest model, whatever the build runs on.
 *
 * They return one JSON object — which specialists to use, which files a defect
 * belongs to. That is a classification, and the model router next door has
 * always been classified by Haiku for exactly this reason: choosing Opus is not
 * a decision worth Opus. These two were the exception, so a brief that routed to
 * Opus paid Opus rates to have a list of specialist names put in order.
 *
 * One of the two — the specialist router — is gone entirely; it returned a
 * constant. The other, the file-repair planner, named this function in its
 * justification and then called the generation model anyway for 67 calls a
 * fortnight. It calls this now.
 *
 * Not a token saving — the calls are small either way — but a direct one in
 * money, and there is nothing on the other side of the trade.
 */
export async function routerModelId(): Promise<string> {
  const { getModelConfig } = await import('../../config/agentcore-config.js')
  return (await getModelConfig()).haikuId
}

