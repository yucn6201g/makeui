#!/bin/bash
set -euo pipefail

# ============================================================
# MakeUI AI - AgentCore Runtime Deployment
# ============================================================
#
# Why this exists rather than a documented command line:
#
#   `update-agent-runtime` REPLACES the runtime configuration — it does not
#   patch it. Omit `--environment-variables` and every variable the runtime had
#   is silently dropped. Nothing fails, the deploy reports READY, and the
#   symptom is remote: `DESIGN_SWARM_ENABLED` disappears, the four-agent design
#   phase stops running, and generations quietly fall back to the single-call
#   path. It has happened.
#
#   So the environment is read back off the live runtime and re-applied, and the
#   deploy refuses to proceed if that read comes back empty. Forgetting is no
#   longer possible; the only way to change a variable is to change it here.
# ============================================================

REGION="ap-northeast-1"
# The runtime id is per deployment; discovered by name unless given.
RUNTIME_ID="${RUNTIME_ID:-$(aws bedrock-agentcore-control list-agent-runtimes --region "${REGION}" --query "agentRuntimes[?starts_with(agentRuntimeName, 'makeuiBackend')].agentRuntimeId | [0]" --output text)}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$(cd "${SCRIPT_DIR}/../backend" && pwd)"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
BUCKET="makeui-outputs-${ACCOUNT_ID}"

echo "============================================================"
echo " AgentCore Runtime deploy - ${RUNTIME_ID} (${REGION})"
echo "============================================================"

# ============================================================
# Build
# ============================================================
#
# SKIP_BUILD is set by the CI pipeline, which has already built AND TESTED this
# exact bundle in an earlier stage. Rebuilding here would deploy an artifact
# nothing has run a test against — which is the one thing a pipeline exists to
# prevent. Unset (the normal case: someone running this by hand) it builds.
if [ "${SKIP_BUILD:-}" = "1" ]; then
  echo "--- Using the bundle from the build stage (SKIP_BUILD=1) ---"
  cd "${BACKEND_DIR}"
  test -s dist/runtime/index.js || { echo "dist/runtime/index.js is missing"; exit 1; }
else
  echo "--- Building runtime bundle ---"
  cd "${BACKEND_DIR}"
  npm run build:runtime
fi

# The Runtime loads index.js as an ES module, which needs the type declaration
# beside it inside the zip.
printf '{"type":"module"}' > dist/runtime/package.json

rm -f dist/makeui-backend.zip
# Python's zipfile rather than PowerShell's Compress-Archive.
#
# Compress-Archive is Windows-only, so this script ran on a developer machine
# and could not run in CodeBuild at all. Python 3 is present on the Windows dev
# machine, in the CodeBuild standard image, and in every environment this repo
# already assumes — `deploy-lambda.sh` has packaged with it from the start.
python3 -c "
import os, zipfile
root = os.path.join('dist', 'runtime')
with zipfile.ZipFile(os.path.join('dist', 'makeui-backend.zip'), 'w', zipfile.ZIP_DEFLATED) as z:
    for base, _, names in os.walk(root):
        for name in names:
            full = os.path.join(base, name)
            z.write(full, os.path.relpath(full, root))
" 2>/dev/null || python -c "
import os, zipfile
root = os.path.join('dist', 'runtime')
with zipfile.ZipFile(os.path.join('dist', 'makeui-backend.zip'), 'w', zipfile.ZIP_DEFLATED) as z:
    for base, _, names in os.walk(root):
        for name in names:
            full = os.path.join(base, name)
            z.write(full, os.path.relpath(full, root))
"

echo "  $(du -h dist/makeui-backend.zip | cut -f1)"

# ============================================================
# Capture the live environment BEFORE replacing anything
# ============================================================
echo "--- Reading current environment variables ---"
ENV_JSON=$(aws bedrock-agentcore-control get-agent-runtime \
  --agent-runtime-id "${RUNTIME_ID}" \
  --region "${REGION}" \
  --query "environmentVariables" \
  --output json)

if [ -z "${ENV_JSON}" ] || [ "${ENV_JSON}" = "null" ] || [ "${ENV_JSON}" = "{}" ]; then
  echo "ERROR: the live runtime reports no environment variables." >&2
  echo "       Deploying now would lock that in. A previous deploy probably" >&2
  echo "       dropped them; restore them explicitly before continuing:" >&2
  echo "" >&2
  echo "  AWS_ACCOUNT_ID, CLOUDFRONT_DOMAIN, COGNITO_USER_POOL_ID," >&2
  echo "  DESIGN_SWARM_ENABLED=1, KB_BUCKET_NAME, OUTPUT_BUCKET_NAME," >&2
  echo "  PORT=8080, USAGE_TABLE_NAME" >&2
  exit 1
fi

echo "  carrying forward: $(echo "${ENV_JSON}" | tr -d '\n' | grep -o '"[A-Z_]*":' | tr -d '":' | paste -sd' ' -)"

# ============================================================
# Variables this build requires, merged in rather than assumed
# ============================================================
# Carrying the live environment forward preserves what is already there but can
# never introduce something new — so a feature that needs a new variable would be
# deployed switched off, silently, exactly like the class of failure this script
# exists to prevent. Anything the code needs is declared here and merged, with
# whatever the runtime already holds winning so an operator's change is not
# overwritten by a default.
# The Browser id is per deployment: read from SSM unless given.
AGENTCORE_BROWSER_ID="${AGENTCORE_BROWSER_ID:-$(MSYS_NO_PATHCONV=1 aws ssm get-parameter --name /makeui/agentcore/browser-id --region "${REGION}" --query Parameter.Value --output text 2>/dev/null || true)}"
if [ -z "${AGENTCORE_BROWSER_ID}" ] || [ "${AGENTCORE_BROWSER_ID}" = "None" ]; then
  echo "ERROR: no AgentCore Browser id (SSM /makeui/agentcore/browser-id). Set AGENTCORE_BROWSER_ID and re-run." >&2
  exit 1
fi
REQUIRED_ENV="{
  \"AGENTCORE_BROWSER_ID\": \"${AGENTCORE_BROWSER_ID}\",
  \"BROWSER_VERIFY_ENABLED\": \"1\"
}"
ENV_JSON=$(echo "${ENV_JSON} ${REQUIRED_ENV}" | python -c \
  'import json,sys; live,req=json.loads("["+sys.stdin.read().replace("} {","},{")+"]"); print(json.dumps({**req,**live}))' \
  2>/dev/null || echo "${ENV_JSON}")

# ============================================================
# The price table, from SSM rather than from here
# ============================================================
# `MODEL_PRICING` decides what a token weighs and what the admin panel reports a
# month cost. Prices change, so they are not in this file and not in the repo:
# backend/scripts/set-model-pricing.sh writes them to /makeui/pricing/models,
# beside the model ids and the preset prefixes, and this reads them back.
#
# Unlike REQUIRED_ENV above, the parameter WINS over the live value — that is
# the whole point of keeping it in SSM, where an operator can change it between
# deploys and expect the change to arrive. An unset parameter leaves whatever
# the runtime already has, so a temporary SSM outage cannot silently un-price
# the account.
PRICING=$(aws ssm get-parameter --name /makeui/pricing/models --region "${REGION}" \
  --query 'Parameter.Value' --output text 2>/dev/null || true)
if [ -n "${PRICING}" ] && [ "${PRICING}" != "None" ]; then
  ENV_JSON=$(PRICING="${PRICING}" python -c \
    'import json,os,sys; env=json.load(sys.stdin); env["MODEL_PRICING"]=os.environ["PRICING"]; print(json.dumps(env))' \
    <<< "${ENV_JSON}")
  echo "  MODEL_PRICING: $(python -c 'import json,sys; print(" ".join(sorted(json.loads(sys.argv[1])["models"])))' "${PRICING}")"
else
  echo "  MODEL_PRICING: not set in SSM — carrying forward whatever the runtime has"
fi

for key in AGENTCORE_BROWSER_ID BROWSER_VERIFY_ENABLED; do
  echo "${ENV_JSON}" | grep -q "\"${key}\"" || { echo "ERROR: ${key} missing after merge" >&2; exit 1; }
done
# MODEL_PRICING is checked separately because its failure is silent rather than
# loud. Without it `weighTokens` returns `inputTokens + outputTokens`, so the
# Runtime keeps working and writes a raw token count into the column the budget
# reads as millionths of a dollar — about a third of the real figure, with no
# error anywhere. That is what makeui-worker was doing until 2026-09-10, and
# deploy-lambda.sh now refuses the same way. A host that records usage without a
# price table must not ship.
echo "${ENV_JSON}" | grep -q '"MODEL_PRICING"'   || { echo "ERROR: MODEL_PRICING missing after merge - the runtime would under-record every run" >&2; exit 1; }
echo "  after merge:      $(echo "${ENV_JSON}" | tr -d '\n' | grep -o '"[A-Z_]*":' | tr -d '":' | paste -sd' ' -)"

# ============================================================
# Upload and switch
# ============================================================
echo "--- Uploading artifact ---"
aws s3 cp dist/makeui-backend.zip "s3://${BUCKET}/backend/makeui-backend.zip" --region "${REGION}"

echo "--- Creating new runtime version ---"
# NODE_22, and it is the only Node this platform offers.
#
# Asked directly, 2026-09-04: update-agent-runtime rejects anything else with
#   [PYTHON_3_10, PYTHON_3_11, PYTHON_3_12, PYTHON_3_13, PYTHON_3_14, NODE_22]
#
# Lambda has moved on — it accepts nodejs20/22/24/26.x — but both artefacts are
# built from the same backend/src, so the type surface has to match the LOWER
# runtime. That is why @types/node stays on 22 while npm reports 26 available:
# it is pinned to this line, not left behind. When AgentCore offers a newer Node,
# this string, the esbuild --target in package.json, the Lambda Runtime in
# infrastructure/template.yaml and @types/node move together.
VERSION=$(aws bedrock-agentcore-control update-agent-runtime \
  --agent-runtime-id "${RUNTIME_ID}" \
  --region "${REGION}" \
  --role-arn "arn:aws:iam::${ACCOUNT_ID}:role/makeui-runtime-role" \
  --network-configuration '{"networkMode":"PUBLIC"}' \
  --agent-runtime-artifact "{\"codeConfiguration\":{\"code\":{\"s3\":{\"bucket\":\"${BUCKET}\",\"prefix\":\"backend/makeui-backend.zip\"}},\"runtime\":\"NODE_22\",\"entryPoint\":[\"index.js\"]}}" \
  --environment-variables "${ENV_JSON}" \
  --query "agentRuntimeVersion" --output text)

echo "  version ${VERSION}"

# ============================================================
# Wait, then verify the environment actually survived
# ============================================================
echo "--- Waiting for READY ---"
for _ in $(seq 1 30); do
  STATUS=$(aws bedrock-agentcore-control get-agent-runtime \
    --agent-runtime-id "${RUNTIME_ID}" --region "${REGION}" \
    --query "status" --output text)
  [ "${STATUS}" = "READY" ] && break
  sleep 6
done

if [ "${STATUS}" != "READY" ]; then
  echo "ERROR: runtime did not reach READY (status: ${STATUS})" >&2
  exit 1
fi

# The whole point of the script — assert the outcome, do not assume it.
AFTER=$(aws bedrock-agentcore-control get-agent-runtime \
  --agent-runtime-id "${RUNTIME_ID}" --region "${REGION}" \
  --query "environmentVariables.DESIGN_SWARM_ENABLED" --output text)

if [ "${AFTER}" != "1" ]; then
  echo "ERROR: DESIGN_SWARM_ENABLED is '${AFTER}' after deploy — the environment" >&2
  echo "       was lost. The design phase will silently fall back." >&2
  exit 1
fi

echo ""
echo "READY - version ${VERSION}, environment intact."
