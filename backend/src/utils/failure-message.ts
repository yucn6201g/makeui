/**
 * What a failed job says to the person who asked for it.
 *
 * `runJob` used to store `e.message` and the chat rendered it verbatim, in an
 * error bubble, with no further processing. Measured over thirty days of
 * production logs, every one of the 42 terminal failures was an English SDK
 * exception — not one was a message anyone had written for a reader:
 *
 *     34  ThrottlingException: Too many tokens per day, please wait before trying again.
 *      4  MaxTokensError: Model reached maximum token limit. This is an
 *         unrecoverable state that requires intervention.
 *      1  ModelError: Stream ended without completing a message
 *      1  InternalServerException: The system encountered an unexpected error…
 *      1  ValidationException: Item size to update has exceeded the maximum allowed size
 *      1  NoSuchBucket: The specified bucket does not exist
 *
 * The comment at that call site said the orchestrators raise messages written
 * for the user and that those should pass through. Some do, but no such message
 * had reached this path in a month. The pass-through was the whole of the
 * handling, and it was handling the case that does not happen while leaving the
 * case that does.
 *
 * Two of these are worth naming individually, because they are the ones where
 * showing the exception is not merely unhelpful but actively misleading.
 * `NoSuchBucket` is a deployment fault; the user did nothing, and there is
 * nothing they can do. `MaxTokensError` ends with 「requires intervention」,
 * which reads as an instruction and names no action.
 *
 * The raw exception is not lost — `runJob` logs `String(e)` against the job id
 * on the line above, which is where it is useful and where it was already going.
 */

/**
 * Whether this message was written for a person to read.
 *
 * A deliberate one is in Japanese, because every message this product raises for
 * a reader is; an SDK exception is not. That is a fact about this codebase
 * rather than a general rule, and it is the reason the check is a character
 * range and not something cleverer. If a user-facing message is ever written in
 * English it will be classified as an exception and replaced by the generic
 * text below — worse than passing it through, but not misleading, which is the
 * failure mode worth protecting against.
 */
const JAPANESE = /[぀-ヿ㐀-鿿]/;

interface Rule {
  /** Matched against `<Name>: <message>`, case-insensitively. */
  test: RegExp;
  message: string;
}

/*
 * Order matters: the first match wins, and the throttling pair is split because
 * the two share an exception name and need opposite advice. A daily token quota
 * does not clear by waiting a minute, and a burst does not clear by waiting a
 * day.
 */
const RULES: Rule[] = [
  {
    test: /too many tokens per day|tokens per day/i,
    message:
      '本日の生成量が上限に達しました。日付が変わると再開できます。'
      + '急ぐ場合は、より小さなモデルでお試しください。',
  },
  {
    test: /throttl|too many requests|rate ?limit|ServiceQuotaExceeded|ProvisionedThroughputExceeded/i,
    message: 'アクセスが集中しています。1分ほど待ってから、もう一度お試しください。',
  },
  {
    test: /MaxTokensError|maximum token limit|max_tokens/i,
    message:
      '出力が長くなりすぎて、最後まで書き切れませんでした。'
      + '指示を分けるか、画面数を減らして、もう一度お試しください。',
  },
  {
    /*
     * Distinct from the throttling cases even though retrying is the advice for
     * both: this one is not about volume, so telling someone to use a smaller
     * model or wait for the day to roll over would send them after the wrong
     * thing.
     */
    test: /stream ended|ModelError|ConnectionError|ECONNRESET|ETIMEDOUT|socket hang up|aborted/i,
    message: 'モデルとの通信が途中で切れました。もう一度お試しください。',
  },
  {
    test: /InternalServerException|ServiceUnavailable|InternalFailure|503|502/i,
    message: 'モデル側で一時的な障害が起きています。少し待ってから、もう一度お試しください。',
  },
  {
    /*
     * Never observed at a size the current pipeline produces — the largest
     * stored result in production is 12.5 KB against a 400 KB item limit, since
     * the document itself goes to S3 and only its metadata is stored here. Kept
     * because it did happen once, and because a size failure that reads as
     * `Item size to update has exceeded the maximum allowed size` gives someone
     * nothing to act on.
     */
    test: /item size|exceeded the maximum allowed size|too large|entity too large|413/i,
    message:
      '生成結果が大きすぎて保存できませんでした。'
      + '画面数を減らすか、指示を分けてお試しください。',
  },
  {
    /*
     * The user did nothing and can do nothing. Deliberately does not suggest
     * retrying: a missing bucket or a denied role is identical on the second
     * attempt, and inviting a retry turns one failure into several.
     */
    test: /NoSuchBucket|NoSuchKey|AccessDenied|UnrecognizedClient|ExpiredToken|InvalidSignature|CredentialsError|ResourceNotFoundException|not authorized/i,
    message:
      'サーバー側の設定に問題があり、処理を完了できませんでした。'
      + 'この失敗は記録されています。お手数ですが、しばらくしてからご確認ください。',
  },
];

const GENERIC =
  '生成に失敗しました。詳細は記録されています。'
  + 'もう一度お試しいただき、続くようであればお知らせください。';

/**
 * The message to store on a failed job, and so the message the chat shows.
 *
 * Returns the thrown message unchanged when it was written for a reader, and a
 * classified one otherwise. Never returns the raw exception: an unmatched
 * exception yields the fallback rather than being passed through, because an
 * unrecognised name is exactly the case where the text is least likely to mean
 * anything to the person reading it.
 *
 * `fallback` names what failed, for callers that are not a generation. Any of
 * them reaches this with the same problem and a different subject, and
 * 「生成に失敗しました」 would be wrong there in a way that sends someone looking
 * at the wrong screen.
 */
export function describeFailure(e: unknown, fallback: string = GENERIC): string {
  const raw = e instanceof Error ? e.message : String(e);
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  if (JAPANESE.test(trimmed)) return trimmed;

  // The exception name is often only on the error object, not in its message.
  const name = e instanceof Error ? e.name : '';
  const subject = `${name}: ${trimmed}`;

  for (const rule of RULES) {
    if (rule.test.test(subject)) return rule.message;
  }
  return fallback;
}

/**
 * Whether the model refused to answer for a reason that another, larger call
 * cannot fix — a throttle, a quota, or Bedrock being briefly unavailable.
 *
 * This exists because of what the callers do with a failed planner. A per-file
 * plan that comes back empty is read as "there is nothing to plan" and the run
 * escalates to rewriting the whole document, which is the single most expensive
 * call in the pipeline — about 113,000 tokens against the planner's 3,300.
 *
 * Measured over 60 days: every one of the thirteen escalations was
 * `ThrottlingException: Too many tokens per day`. The account had run out of
 * daily tokens, the cheap call was refused for it, and the response was to
 * attempt the most expensive call there is. It cannot succeed, and if it does
 * it spends what little is left.
 *
 * So "the model would not answer" has to be tellable from "the model had nothing
 * to say". Only the first is matched here; a malformed reply is the second and
 * is still worth a fallback.
 */
export function isModelUnavailable(e: unknown): boolean {
  const name = (e as { name?: string })?.name ?? '';
  const message = e instanceof Error ? e.message : String(e);
  const text = `${name} ${message}`;
  return /Throttling|TooManyRequests|ServiceQuotaExceeded|ServiceUnavailable|InternalServerException|Too many tokens|rate limit/i.test(text);
}
