import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { NodeHttpHandler } from '@smithy/node-http-handler';

/**
 * One Bedrock client, with a timeout.
 *
 * The SDK's default request timeout is zero, which means no timeout at all — a
 * response that never arrives is waited on forever. Measured: a generation
 * entered the preset-conformance pass, made one call, and sat there. Thirty-two
 * minutes later the job record had not been touched since the call started, no
 * error had been raised, and nothing had been written. The client polls for
 * sixteen minutes, so from the user's side that is a build that never ends and
 * never says why.
 *
 * Four modules each built their own client with the same defect, so this is the
 * only one now. A future module that constructs its own gets the defect back,
 * which is the argument for it living here rather than being a parameter.
 */

/**
 * Ten minutes.
 *
 * The bound has to sit above the slowest *legitimate* call, because cutting one
 * of those off turns a slow build into a failed one. The longest healthy call
 * observed is the code assembler writing a multi-screen React project: 5m30s
 * measured end to end on a run that produced 80KB. Ten minutes is roughly twice
 * that, and half the repair budget, so a hung call is caught well inside the
 * window the job itself is allowed.
 *
 * `requestTimeout` covers a socket that stops delivering data, which is the
 * shape of the failure seen. `connectionTimeout` is much shorter because
 * failing to establish a connection at all is never slow-but-fine.
 */
const BEDROCK_REQUEST_TIMEOUT_MS = 10 * 60_000;
const CONNECTION_TIMEOUT_MS = 10_000;

export function createBedrockClient(): BedrockRuntimeClient {
  return new BedrockRuntimeClient({
    region: process.env.AWS_REGION || 'ap-northeast-1',
    requestHandler: new NodeHttpHandler({
      requestTimeout: BEDROCK_REQUEST_TIMEOUT_MS,
      connectionTimeout: CONNECTION_TIMEOUT_MS,
    }),
  });
}
