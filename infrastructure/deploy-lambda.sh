#!/bin/bash
set -euo pipefail

# ============================================================
# MakeUI AI - API Lambda Deployment (makeui-backend / makeui-worker)
# ============================================================
#
# Why this exists rather than a documented command line:
#
#   `backend/dist/` holds TWO deployable artifacts that look interchangeable and
#   are not. `deploy-runtime.sh` writes `dist/makeui-backend.zip` for the
#   AgentCore Runtime — it contains `index.js`. The Lambdas are configured with
#   handler `lambda.handler`, so their zip must contain `lambda.mjs`.
#
#   Deploying the runtime zip to a Lambda fails in the worst possible way: the
#   upload succeeds, the API keeps its URL, and every request dies in
#   `Runtime.ImportModuleError: Cannot find module 'lambda'` — before the handler
#   runs, so before any CORS header is written. The browser cannot see a status
#   code at all and reports `Failed to fetch`, which reads like a network or CORS
#   problem and sends you looking in the wrong place entirely. It has happened,
#   and it took a log read to find.
#
#   So the artifact is built and packaged here rather than chosen by hand, and
#   the script refuses to upload a zip that does not contain `lambda.mjs`.
# ============================================================

REGION="ap-northeast-1"
FUNCTIONS=("makeui-backend" "makeui-worker")
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$(cd "${SCRIPT_DIR}/../backend" && pwd)"
# Relative, and every aws call below runs from BACKEND_DIR. Under Git Bash an
# absolute path expands to `/c/work/…`, which the native AWS CLI cannot open —
# `Unable to load paramfile`. deploy-runtime.sh keeps its paths relative for the
# same reason.
ZIP="dist/lambda.zip"

echo "============================================================"
echo " MakeUI API Lambda deployment"
echo "============================================================"

# SKIP_BUILD is set by the CI pipeline, which built and TESTED this exact
# bundle in an earlier stage. Rebuilding here would deploy an artifact nothing
# has run a test against.
if [ "${SKIP_BUILD:-}" = "1" ]; then
  echo "--- Using the bundle from the build stage (SKIP_BUILD=1) ---"
  cd "${BACKEND_DIR}"
  test -s dist/lambda.mjs || { echo "dist/lambda.mjs is missing"; exit 1; }
else
  echo "--- Building ---"
  cd "${BACKEND_DIR}"
  npm run build
fi

echo "--- Packaging ---"
# Only lambda.mjs. The .map is 11MB and Lambda has no use for it.
python -c "
import zipfile, os, sys
src = os.path.join('dist', 'lambda.mjs')
if not os.path.exists(src):
    sys.exit('dist/lambda.mjs is missing — the build did not produce a bundle')
with zipfile.ZipFile('dist/lambda.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    z.write(src, 'lambda.mjs')
print('  packaged %.1f MB -> %.1f MB' % (os.path.getsize(src)/1e6, os.path.getsize('dist/lambda.zip')/1e6))
"

# The check that makes the mistake above impossible to repeat.
python -c "
import zipfile, sys
names = zipfile.ZipFile('dist/lambda.zip').namelist()
if 'lambda.mjs' not in names:
    sys.exit('REFUSING TO DEPLOY: zip contains %s, not lambda.mjs. '
             'This is the AgentCore Runtime artifact, not the Lambda bundle.' % names)
print('  verified: zip contains lambda.mjs (handler is lambda.handler)')
"

for fn in "${FUNCTIONS[@]}"; do
  echo "--- Deploying ${fn} ---"
  aws lambda update-function-code \
    --function-name "${fn}" \
    --zip-file "fileb://${ZIP}" \
    --region "${REGION}" \
    --query 'LastUpdateStatus' --output text
  aws lambda wait function-updated --function-name "${fn}" --region "${REGION}"
done

# ============================================================
# The environment, which this script used not to touch at all
# ============================================================
# Only code was deployed here, so every variable stayed as CloudFormation
# stamped it at stack creation and drifted from that day on. Two ways that hurt,
# both found on 2026-09-10:
#
#   makeui-worker had no MODEL_PRICING. `weighTokens` returns the raw token sum
#   without a table, so a job that fell back to the worker recorded ~200k where
#   the same run on the Runtime recorded 594k millionths of a dollar — a third
#   of the cost, against a budget enforced in dollars. Invisible, because the
#   worker only runs when the Runtime is down.
#
#   Both functions carried KNOWLEDGE_BASE_ID, GUARDRAIL_ID, GUARDRAIL_VERSION
#   and MEMORY_ID, which no code reads: those four parameters are read from SSM
#   at runtime. `{{resolve:ssm:...}}` resolves once, at stack deploy, so the
#   stamped copies drifted too — KNOWLEDGE_BASE_ID named a deleted knowledge
#   base and GUARDRAIL_VERSION said 1 against a guardrail on 3.
#
# So the price table is pushed from SSM on every deploy, the same way
# deploy-runtime.sh does it, and the dead four are removed if present. A value
# with one live source belongs in that source only.
PRICING=$(aws ssm get-parameter --name /makeui/pricing/models --region "${REGION}"   --query 'Parameter.Value' --output text 2>/dev/null || true)

for fn in "${FUNCTIONS[@]}"; do
  CURRENT=$(aws lambda get-function-configuration --function-name "${fn}"     --region "${REGION}" --query 'Environment.Variables' --output json)
  NEXT=$(PRICING="${PRICING}" FN="${fn}" python -c '
import json, os, sys
env = json.load(sys.stdin)
before = dict(env)
for dead in ("KNOWLEDGE_BASE_ID", "GUARDRAIL_ID", "GUARDRAIL_VERSION", "MEMORY_ID"):
    env.pop(dead, None)
pricing = os.environ.get("PRICING", "")
# An unset or unreadable parameter leaves whatever the function already has, so
# a transient SSM failure cannot silently un-price an account.
if pricing and pricing != "None":
    env["MODEL_PRICING"] = pricing
if env == before:
    print("")
else:
    print(json.dumps({"Variables": env}))
' <<< "${CURRENT}")
  if [ -z "${NEXT}" ]; then
    echo "  ${fn}: environment already correct"
  else
    echo "  ${fn}: updating environment"
    aws lambda update-function-configuration --function-name "${fn}"       --region "${REGION}" --environment "${NEXT}" --query 'LastUpdateStatus' --output text
    aws lambda wait function-updated --function-name "${fn}" --region "${REGION}"
  fi
done

# Which origins the API answers, for makeui-backend. The code has always read
# ALLOWED_ORIGIN and for months nothing set it, so the default applied and the
# API answered every origin on the web while looking configured. The stack set
# it while the function was a stack resource; since 2026-09-16 it is not (see
# the note in template.yaml), so this is where it is guaranteed. Only filled in
# when missing: a deliberate value on the function is left alone.
DOMAIN=$(aws ssm get-parameter --name /makeui/cloudfront-domain --region "${REGION}"   --query 'Parameter.Value' --output text 2>/dev/null || true)
if [ -n "${DOMAIN}" ] && [ "${DOMAIN}" != "None" ]; then
  CURRENT=$(aws lambda get-function-configuration --function-name makeui-backend     --region "${REGION}" --query 'Environment.Variables' --output json)
  NEXT=$(DOMAIN="${DOMAIN}" python -c '
import json, os, sys
env = json.load(sys.stdin)
if env.get("ALLOWED_ORIGIN"):
    print("")
else:
    env["ALLOWED_ORIGIN"] = "https://" + os.environ["DOMAIN"] + ",http://localhost:5173"
    print(json.dumps({"Variables": env}))
' <<< "${CURRENT}")
  if [ -n "${NEXT}" ]; then
    echo "  makeui-backend: setting ALLOWED_ORIGIN"
    aws lambda update-function-configuration --function-name makeui-backend       --region "${REGION}" --environment "${NEXT}" --query 'LastUpdateStatus' --output text
    aws lambda wait function-updated --function-name makeui-backend --region "${REGION}"
  fi
fi

# The one that decides what a run is billed. A function that records usage
# without it under-reports by roughly threefold and nothing says so.
for fn in "${FUNCTIONS[@]}"; do
  aws lambda get-function-configuration --function-name "${fn}" --region "${REGION}"     --query 'Environment.Variables.MODEL_PRICING' --output text | grep -q '^{'     || { echo "ERROR: ${fn} has no MODEL_PRICING after the merge" >&2; exit 1; }
done

echo "--- Verifying the module actually loads ---"
# An unauthenticated request is enough: it proves the bundle imported, the router
# ran and the handler wrote its headers. A broken bundle cannot reach any of that.
# Paths stay relative here too, for the same Git Bash reason as above.
mkdir -p dist/verify

# The origin the deployed function actually allows, taken from the deployed
# function. Hardcoding one here is how this check came to assert a header that
# had stopped being written: it sent no Origin at all and required the reply to
# carry `Access-Control-Allow-Origin`, which was only ever true because the
# setting defaulted to `*`. Now that it is an allowlist, no Origin correctly
# means no header, and the check failed a deploy that was right.
ORIGIN=$(aws lambda get-function-configuration --function-name makeui-backend \
  --region "${REGION}" --query 'Environment.Variables.ALLOWED_ORIGIN' --output text 2>/dev/null | cut -d, -f1)
if [ -z "${ORIGIN}" ] || [ "${ORIGIN}" = "None" ] || [ "${ORIGIN}" = "*" ]; then
  ORIGIN='https://example.invalid'
  EXPECT_ECHO='*'
else
  EXPECT_ECHO="${ORIGIN}"
fi

probe() {
  printf '{"httpMethod":"GET","path":"/projects","headers":{"origin":"%s"},"requestContext":{"http":{"method":"GET","path":"/projects"}}}' "$1" > dist/verify/in.json
  aws lambda invoke --function-name makeui-backend --payload fileb://dist/verify/in.json \
    --region "${REGION}" "$2" --query 'FunctionError' --output text
}

probe "${ORIGIN}" dist/verify/allowed.json
# A stranger, to prove the list is a list and not a rubber stamp. This is the
# assertion the old check could not make, and the direction that actually
# matters: a wildcard passes "is the header present" every time.
probe 'https://not-allowed.example' dist/verify/denied.json

if ! grep -q '"statusCode":401' dist/verify/allowed.json; then
  echo ""
  echo "FAILED - the handler did not load or route:"
  cat dist/verify/allowed.json
  exit 1
fi
if ! grep -q "\"Access-Control-Allow-Origin\":\"${EXPECT_ECHO}\"" dist/verify/allowed.json; then
  echo ""
  echo "FAILED - an allowed origin (${ORIGIN}) was not echoed back:"
  cat dist/verify/allowed.json
  exit 1
fi
if [ "${EXPECT_ECHO}" != '*' ] && grep -q 'Access-Control-Allow-Origin' dist/verify/denied.json; then
  echo ""
  echo "FAILED - an origin outside the allowlist was given a CORS header:"
  cat dist/verify/denied.json
  exit 1
fi

echo "--- Verifying CORS through API Gateway ---"
# Everything above invokes the function directly, which is not the path a browser
# takes. The HTTP API has a CorsConfiguration of its own, and when one is set API
# Gateway answers preflight itself and replaces the integration's CORS headers on
# every reply. It was `*`, so every origin on the web was allowed while the check
# above passed on every deploy: the handler's allowlist was right and unused.
#
# The API is the one that decides, so it is compared with the function's list and
# then asked over HTTP, with an allowed origin and a stranger. The API is outside
# the stack and is looked up by name; its id is not in the repository.
API_ID=$(aws apigatewayv2 get-apis --region "${REGION}" \
  --query "Items[?Name=='makeui-api'].ApiId | [0]" --output text | tr -d '\r')
if [ -z "${API_ID}" ] || [ "${API_ID}" = "None" ]; then
  echo "FAILED - no HTTP API named makeui-api in ${REGION}"
  exit 1
fi
API_URL=$(aws apigatewayv2 get-api --api-id "${API_ID}" --region "${REGION}" --query 'ApiEndpoint' --output text | tr -d '\r')
API_ORIGINS=$(aws apigatewayv2 get-api --api-id "${API_ID}" --region "${REGION}" \
  --query 'CorsConfiguration.AllowOrigins' --output text | tr -d '\r' | tr '\t' '\n' | sort | paste -sd, -)
FN_ORIGINS=$(aws lambda get-function-configuration --function-name makeui-backend --region "${REGION}" \
  --query 'Environment.Variables.ALLOWED_ORIGIN' --output text | tr -d '\r' | tr ',' '\n' | sed 's/^ *//;s/ *$//' | sort | paste -sd, -)
if [ "${API_ORIGINS}" != "${FN_ORIGINS}" ]; then
  echo ""
  echo "FAILED - the API's CORS origins and the function's ALLOWED_ORIGIN disagree:"
  echo "  API      ${API_ORIGINS}"
  echo "  function ${FN_ORIGINS}"
  echo "  The API's list is the one browsers get. Set them to the same origins:"
  echo "  aws apigatewayv2 update-api --api-id <id> --cors-configuration '{\"AllowOrigins\":[...],...}'"
  exit 1
fi

# The reply headers for one request. `-D -` with the body discarded.
http_headers() {
  curl -s -D - -o /dev/null "$@" | tr -d '\r'
}
PREFLIGHT=(-X OPTIONS -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: authorization,content-type')

# Same expectation as the direct check: the allowed origin echoed, or `*` when the
# list is `*` — in which case there is no stranger to refuse.
if ! http_headers "${PREFLIGHT[@]}" -H "Origin: ${ORIGIN}" "${API_URL}/projects" \
  | grep -qixF "access-control-allow-origin: ${EXPECT_ECHO}"; then
  echo ""
  echo "FAILED - API Gateway did not allow ${ORIGIN} on preflight"
  exit 1
fi
STRANGER=(-H 'Origin: https://not-allowed.example' "${API_URL}/projects")
if [ "${EXPECT_ECHO}" != '*' ] && { http_headers "${PREFLIGHT[@]}" "${STRANGER[@]}" | grep -qi '^access-control-allow-origin:' \
  || http_headers "${STRANGER[@]}" | grep -qi '^access-control-allow-origin:'; }; then
  echo ""
  echo "FAILED - API Gateway gave an origin outside the allowlist a CORS header"
  exit 1
fi

echo ""
echo "READY - handler loads, routes, and API Gateway answers ${ORIGIN} but not a stranger."
rm -rf dist/verify
