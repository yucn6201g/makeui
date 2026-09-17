#!/bin/bash
set -euo pipefail

# Install the price table that MODEL_PRICING carries.
#
# Usage: ./set-model-pricing.sh <file.json>   # from fetch-model-pricing.mjs
#        ./set-model-pricing.sh --show
#        ./set-model-pricing.sh --clear
#        ./set-model-pricing.sh --enforce on|off
#
# Where it goes, and why two places:
#
#   SSM /makeui/pricing/models   the source of truth, beside /makeui/models/*
#                                and the preset prefixes. Editable without a
#                                deploy, and not in the repository — prices
#                                change and a number in git ages silently.
#   the Lambda's environment     applied here and now. deploy-lambda.sh updates
#                                CODE only, so a variable set directly survives
#                                every deploy.
#
# The Runtime is deliberately NOT written here. `update-agent-runtime` REPLACES
# the whole configuration rather than patching it — omit one field and the
# runtime silently loses it — so only infrastructure/deploy-runtime.sh touches
# it, and that script reads this parameter. The Runtime therefore picks the
# table up on its next deploy, which is what records `weightedTokens`; the
# Lambda has it immediately, which is what shows the cost column.
#
# Get the file from the prices AWS publishes rather than typing them:
#
#   node scripts/fetch-model-pricing.mjs > prices.json
#   ./scripts/set-model-pricing.sh prices.json
#
# Setting the table does not move anybody's limit. That is MODEL_PRICING_ENFORCE,
# a separate switch — `--enforce on` — because weighting multiplies a Haiku month
# by 2.83 and a Sonnet month by 8.50 against this account's measured input/output
# mix. Off, a budget is compared against a plain token count while the panel draws
# the money: the bar can read $28 of $10 and still let the next build through. On,
# the two are the same number.
#
# Only the Lambda needs it. `pricingEnforced` is read in `checkUsageLimit` and
# nowhere else, and the gate is the Lambda's; the Runtime records `weightedTokens`
# from the table itself and never consults the switch.

REGION="${AWS_REGION:-ap-northeast-1}"
PARAM="${PRICING_PARAM:-/makeui/pricing/models}"
FUNCTION_NAME="${FUNCTION_NAME:-makeui-backend}"
RUNTIME_ID="${RUNTIME_ID:-$(aws bedrock-agentcore-control list-agent-runtimes --region "${REGION:-ap-northeast-1}" --query "agentRuntimes[?starts_with(agentRuntimeName, 'makeuiBackend')].agentRuntimeId | [0]" --output text)}"

export MSYS_NO_PATHCONV=1

show() {
  echo "--- SSM ${PARAM} ---"
  aws ssm get-parameter --name "${PARAM}" --region "${REGION}" \
    --query 'Parameter.Value' --output text 2>/dev/null || echo "(unset)"
  echo "--- Lambda ${FUNCTION_NAME} ---"
  aws lambda get-function-configuration --function-name "${FUNCTION_NAME}" \
    --region "${REGION}" --query 'Environment.Variables.MODEL_PRICING' --output text
  echo "--- Runtime ${RUNTIME_ID} ---"
  aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "${RUNTIME_ID}" \
    --region "${REGION}" --query 'environmentVariables.MODEL_PRICING' --output text
  echo "--- enforcement ---"
  aws lambda get-function-configuration --function-name "${FUNCTION_NAME}" \
    --region "${REGION}" --query 'Environment.Variables.MODEL_PRICING_ENFORCE' --output text
}

if [ "${1:-}" = "--show" ]; then show; exit 0; fi

if [ "${1:-}" = "--enforce" ]; then
  case "${2:-}" in
    on|off) ;;
    *) echo "Usage: $0 --enforce on|off" >&2; exit 1 ;;
  esac
  ENV_NOW=$(aws lambda get-function-configuration --function-name "${FUNCTION_NAME}" \
    --region "${REGION}" --query 'Environment.Variables' --output json)
  # Refuse to enforce a table that is not there. Every limit would be compared
  # against a plain token count anyway, so the switch would read as on while
  # nothing whatever had changed.
  if [ "${2}" = "on" ] && ! grep -q '"MODEL_PRICING"' <<< "${ENV_NOW}"; then
    echo "No MODEL_PRICING on ${FUNCTION_NAME} — install a table first." >&2
    exit 1
  fi
  NEW_ENV=$(ON="${2}" python -c '
import json, os, sys
env = json.load(sys.stdin)
if os.environ["ON"] == "on":
    env["MODEL_PRICING_ENFORCE"] = "1"
else:
    env.pop("MODEL_PRICING_ENFORCE", None)
print(json.dumps({"Variables": env}))' <<< "${ENV_NOW}")
  aws lambda update-function-configuration --function-name "${FUNCTION_NAME}" \
    --region "${REGION}" --environment "${NEW_ENV}" --query 'LastModified' --output text \
    | sed "s/^/  enforcement ${2} at /"
  if [ "${2}" = "on" ]; then
    echo "Budgets are now compared against the weighted figure — the money."
  else
    echo "Budgets are back to the plain token count."
  fi
  exit 0
fi

if [ $# -lt 1 ]; then
  sed -n '4,42p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
fi

if [ "${1}" = "--clear" ]; then
  PRICING=""
  echo "Clearing the table — every token goes back to weighing the same."
else
  [ -f "${1}" ] || { echo "No such file: ${1}" >&2; exit 1; }
  # Validated here rather than at the far end: the reader ignores a malformed
  # table, so an unchecked one would look installed and do nothing.
  PRICING=$(python -c '
import json, sys
d = json.load(open(sys.argv[1]))
models = d.get("models")
assert isinstance(models, dict) and models, "models is required and must not be empty"
for name, m in models.items():
    for k in ("input", "output", "cacheRead", "cacheWrite"):
        v = m[k]
        assert isinstance(v, (int, float)) and v >= 0, f"{name}.{k} is not a price: {v!r}"
print(json.dumps(d, separators=(",", ":")))' "${1}")
  echo "Table:"
  python -c 'import json,sys; d=json.loads(sys.argv[1]); [print("  %-8s in %-7s out %-7s cacheWrite %-7s cacheRead %s" % (k, m["input"], m["output"], m["cacheWrite"], m["cacheRead"])) for k, m in sorted(d["models"].items())]' "${PRICING}"
fi
echo ""

echo "--- SSM ${PARAM} ---"
if [ -z "${PRICING}" ]; then
  aws ssm delete-parameter --name "${PARAM}" --region "${REGION}" 2>/dev/null \
    && echo "  deleted" || echo "  was not set"
else
  aws ssm put-parameter --name "${PARAM}" --value "${PRICING}" --type String \
    --overwrite --region "${REGION}" --query 'Version' --output text | sed 's/^/  version /'
fi

echo "--- Lambda ${FUNCTION_NAME} ---"
LAMBDA_ENV=$(aws lambda get-function-configuration --function-name "${FUNCTION_NAME}" \
  --region "${REGION}" --query 'Environment.Variables' --output json)
NEW_LAMBDA=$(PRICING="${PRICING}" python -c '
import json, os, sys
env = json.load(sys.stdin)
p = os.environ["PRICING"]
if p:
    env["MODEL_PRICING"] = p
else:
    env.pop("MODEL_PRICING", None)
print(json.dumps({"Variables": env}))' <<< "${LAMBDA_ENV}")
aws lambda update-function-configuration --function-name "${FUNCTION_NAME}" \
  --region "${REGION}" --environment "${NEW_LAMBDA}" --query 'LastModified' --output text | sed 's/^/  updated /'

echo ""
echo "The admin panel has it now. The Runtime picks it up on its next deploy,"
echo "which is when weightedTokens starts being recorded."
