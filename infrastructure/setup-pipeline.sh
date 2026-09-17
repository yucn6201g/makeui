#!/usr/bin/env bash
# ============================================================
# MakeUI AI - CI/CD pipeline setup (run once)
# ============================================================
#
# Creates the CodeCommit repository, the CodeBuild projects, the CodePipeline
# and the push trigger, then pushes the current working tree as the first
# commit. After this, `git push` is the deploy.
#
# Idempotent: re-running it updates the stack and pushes again. The repository
# and the artifact bucket are Retain, so a stack rollback cannot take the source.
set -euo pipefail

REGION="${AWS_REGION:-ap-northeast-1}"
STACK_NAME="makeui-pipeline"
REPO_NAME="makeui"
BRANCH="main"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "============================================================"
echo " MakeUI CI/CD setup - ${STACK_NAME} (${REGION})"
echo "============================================================"

# ------------------------------------------------------------
# The runtime id is not discoverable from CloudFormation.
#
# AgentCore has no CloudFormation resource type, so the runtime this pipeline
# deploys to is passed in as a parameter. Resolved here by name rather than
# hard-coded, so a rebuilt runtime does not silently keep deploying to the old
# one.
# ------------------------------------------------------------
RUNTIME_NAME="${RUNTIME_NAME:-}"
if [ -z "${RUNTIME_NAME}" ]; then
  RUNTIME_NAME=$(aws bedrock-agentcore-control list-agent-runtimes --region "${REGION}" \
    --query "agentRuntimes[?starts_with(agentRuntimeName, 'makeuiBackend')].agentRuntimeName | [0]" \
    --output text 2>/dev/null || echo "None")
fi
if [ -z "${RUNTIME_NAME}" ] || [ "${RUNTIME_NAME}" = "None" ]; then
  echo "ERROR: could not find an AgentCore runtime named makeuiBackend*."
  echo "       Set RUNTIME_NAME=<name> and re-run."
  exit 1
fi
echo "  runtime: ${RUNTIME_NAME}"

# ------------------------------------------------------------
# Stack
# ------------------------------------------------------------
echo ""
echo "--- Deploying the pipeline stack ---"
aws cloudformation deploy \
  --stack-name "${STACK_NAME}" \
  --template-file "${SCRIPT_DIR}/pipeline.yaml" \
  --parameter-overrides "RepositoryName=${REPO_NAME}" "BranchName=${BRANCH}" "RuntimeName=${RUNTIME_NAME}" \
  --capabilities CAPABILITY_NAMED_IAM \
  --tags Project=makeui system=makeui \
  --region "${REGION}" \
  --no-fail-on-empty-changeset

CLONE_URL=$(aws cloudformation describe-stacks --stack-name "${STACK_NAME}" --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='RepositoryCloneUrl'].OutputValue | [0]" --output text)
CONSOLE_URL=$(aws cloudformation describe-stacks --stack-name "${STACK_NAME}" --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='PipelineConsoleUrl'].OutputValue | [0]" --output text)

echo "  repository: ${CLONE_URL}"

# ------------------------------------------------------------
# Local git
#
# The working tree is not a git repository yet. Initialising it here rather than
# asking for it means the first run of this script leaves a working deploy path,
# which is the point of a setup script.
# ------------------------------------------------------------
echo ""
echo "--- Preparing the local repository ---"
cd "${ROOT_DIR}"

if [ ! -d .git ]; then
  git init -q
  git checkout -q -b "${BRANCH}" 2>/dev/null || git branch -q -M "${BRANCH}"
  echo "  initialised"
else
  echo "  already a git repository"
fi

# The credential helper is what makes `git push` work against CodeCommit with
# nothing but the AWS credentials already configured. Set locally, so it cannot
# affect the developer's other repositories.
#
# The empty value first is not redundant. Git *appends* helpers, and a global
# `credential.helper=manager` (the default on Windows) therefore runs BEFORE
# this one — Credential Manager caches what the AWS helper produced on the
# first push, and those credentials are a time-limited SigV4 signature. The
# second push then replays an expired one and CodeCommit answers 401, then 403.
# Measured exactly that way: two pushes worked, the third did not, and nothing
# about the repository or the IAM policy had changed. An empty value resets the
# inherited list, so only the AWS helper is consulted.
git config --local --unset-all credential.helper 2>/dev/null || true
git config --local --add credential.helper ''
git config --local --add credential.helper '!aws codecommit credential-helper $@'
git config --local credential.UseHttpPath true

if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "${CLONE_URL}"
else
  git remote add origin "${CLONE_URL}"
fi
echo "  origin -> ${CLONE_URL}"

# ------------------------------------------------------------
# Log retention
# ------------------------------------------------------------
# CodeBuild creates its log groups implicitly, on first run, with no expiry.
# Three of the four had been given 30 days by hand and the fourth had not, so
# makeui-smoke-test was retaining build output forever — the kind of leak that
# costs nothing to begin with and is only ever noticed on a bill.
#
# Set here rather than declared in pipeline.yaml: the groups are created by
# CodeBuild rather than by the stack, so CloudFormation would have to import
# them, and a first run creates them after this script has finished. Hence the
# retry note below.
echo ""
echo "--- Log retention ---"
for lg in makeui-build makeui-deploy-backend makeui-deploy-frontend makeui-smoke-test; do
  if MSYS_NO_PATHCONV=1 aws logs put-retention-policy --log-group-name "/aws/codebuild/${lg}" --retention-in-days 30 --region "${REGION}" 2>/dev/null; then
    echo "  /aws/codebuild/${lg}: 30 days"
  else
    # Not an error worth stopping for: the group does not exist until that
    # project has run once. Re-run this script, or the loop above by hand,
    # after the first pipeline execution.
    echo "  /aws/codebuild/${lg}: not created yet — re-run after the first build"
  fi
done

# ------------------------------------------------------------
# First push
# ------------------------------------------------------------
echo ""
echo "--- Pushing ---"
git add -A
if git diff --cached --quiet; then
  echo "  nothing to commit"
else
  git commit -q -m "MakeUI: source for the CI/CD pipeline"
  echo "  committed"
fi
git push -u origin "${BRANCH}"

echo ""
echo "============================================================"
echo " Done."
echo ""
echo " The push above has already started a pipeline execution."
echo " Watch it here:"
echo "   ${CONSOLE_URL}"
echo ""
echo " From now on, deploying is:"
echo "   git add -A && git commit -m '...' && git push"
echo "============================================================"
