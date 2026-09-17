/**
 * An ARN with the AWS account id taken out.
 *
 * Parameter Store holds each model as a full inference-profile ARN —
 * `arn:aws:bedrock:ap-northeast-1:<account>:inference-profile/jp.anthropic.claude-…`
 * — and that string was sent to the browser as it was stored. Two routes did
 * it: `/admin/models`, where it was noticed, and `/models`, which answers EVERY
 * signed-in user and was carrying the account id in a `modelId` field no part of
 * the frontend reads.
 *
 * Masked on the server, not in the panel. A mask applied in React still ships the
 * id in the response, where it is one click away in the network tab — and hiding
 * a value on screen while sending it is the version of this that looks fixed.
 *
 * The shape is kept rather than the field dropped: the panel shows which profile
 * each tier calls, and `describeModelId` reads the scope, vendor and version off
 * the segment after the last `/`, which the mask does not touch.
 */

/**
 * The account field of an ARN: the fifth colon-separated field, twelve digits.
 *
 * Anchored on the ARN's own structure rather than on "any twelve digits", so a
 * snapshot date in the profile id (`20251001`, eight digits) or a future id with
 * a long number in it cannot be mistaken for an account.
 */
const ACCOUNT_IN_ARN = /^(arn:[^:]*:[^:]*:[^:]*:)(\d{12})(:)/;

export function maskAccountId(value: string): string {
  if (!value) return value;
  return value.replace(ACCOUNT_IN_ARN, (_m, head: string, _account: string, tail: string) => `${head}************${tail}`);
}
