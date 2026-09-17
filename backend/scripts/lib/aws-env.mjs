// Where the deployed resources are, read from the account instead of written into the scripts.
//
// The operational scripts used to carry this deployment's bucket name, user pool
// id and AgentCore Runtime id as literals, which is one account's details in a
// repository meant to be readable by anyone — and wrong for any other deployment.
// Each value is taken from an environment variable when set, and otherwise from
// the SSM parameters the infrastructure writes (/makeui/...) or, for the Runtime,
// from the AgentCore control plane. Looked up once per process.
import { execFileSync } from 'node:child_process';

export const REGION = process.env.AWS_REGION || 'ap-northeast-1';

const cache = new Map();
function aws(args) {
  const key = args.join(' ');
  if (!cache.has(key)) {
    cache.set(key, execFileSync('aws', [...args, '--region', REGION, '--output', 'text'], {
      // Git Bash rewrites a leading "/" into a Windows path; SSM names start with one.
      env: { ...process.env, MSYS_NO_PATHCONV: '1' },
    }).toString().trim());
  }
  return cache.get(key);
}

const ssm = (name) => aws(['ssm', 'get-parameter', '--name', name, '--query', 'Parameter.Value']);

/** The bucket generated documents, versions and stock images live in. */
export function outputsBucket() {
  return process.env.OUTPUT_BUCKET_NAME || process.env.OUTPUTS_BUCKET || ssm('/makeui/outputs-bucket');
}

/** The Cognito user pool the app signs users into. */
export function userPoolId() {
  return process.env.USER_POOL_ID || ssm('/makeui/cognito/user-pool-id');
}

/** The AgentCore Runtime id (not its name): the first runtime whose name starts with makeuiBackend. */
export function runtimeId() {
  return process.env.RUNTIME_ID || aws([
    'bedrock-agentcore-control', 'list-agent-runtimes',
    '--query', "agentRuntimes[?starts_with(agentRuntimeName, 'makeuiBackend')].agentRuntimeId | [0]",
  ]);
}

/** The CloudWatch log group the Runtime writes to. */
export function runtimeLogGroup() {
  return process.env.RUNTIME_LOG_GROUP || `/aws/bedrock-agentcore/runtimes/${runtimeId()}-DEFAULT`;
}
