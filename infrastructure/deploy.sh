#!/bin/bash
set -euo pipefail

# ============================================================
# MakeUI AI - Infrastructure Deployment Script
# ============================================================

STACK_NAME="makeui-infra"
REGION="ap-northeast-1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE_FILE="${SCRIPT_DIR}/template.yaml"

echo "============================================================"
echo " MakeUI AI - Infrastructure Deployment"
echo "============================================================"
echo ""
echo "Configuration:"
echo "  Stack:  ${STACK_NAME} (${REGION})"
echo ""

# ============================================================
# Validate template
# ============================================================
echo "--- Validating CloudFormation template ---"

# The CloudFront domain published documents may load images from. It belongs to
# this deployment, so it comes from SSM (written after the first deploy) rather
# than from the template; empty on a first deploy, as the template explains.
PUBLISHED_ASSET_HOST="${PUBLISHED_ASSET_HOST:-$(MSYS_NO_PATHCONV=1 aws ssm get-parameter --name /makeui/cloudfront-domain --region "${REGION}" --query Parameter.Value --output text 2>/dev/null || true)}"

# The AgentCore runtime and memory the backend role is granted, found the way
# deploy-runtime.sh and setup-agentcore.sh record them. Empty before
# setup-agentcore.sh has run, which leaves those two grants out.
AGENT_RUNTIME_ARN="${AGENT_RUNTIME_ARN:-$(aws bedrock-agentcore-control list-agent-runtimes --region "${REGION}" --query "agentRuntimes[?starts_with(agentRuntimeName, 'makeuiBackend')].agentRuntimeArn | [0]" --output text 2>/dev/null || true)}"
AGENTCORE_MEMORY_ID="${AGENTCORE_MEMORY_ID:-$(MSYS_NO_PATHCONV=1 aws ssm get-parameter --name /makeui/agentcore/memory-id --region "${REGION}" --query Parameter.Value --output text 2>/dev/null || true)}"
[ "${AGENT_RUNTIME_ARN}" = "None" ] && AGENT_RUNTIME_ARN=""
[ "${AGENTCORE_MEMORY_ID}" = "None" ] && AGENTCORE_MEMORY_ID=""

# The functions are not in this stack; the sweep's rule and permission name one.
if aws lambda get-function --function-name makeui-backend --region "${REGION}" > /dev/null 2>&1; then
  BACKEND_FUNCTION_EXISTS=true
else
  BACKEND_FUNCTION_EXISTS=false
fi

PARAMETERS=(
  "ParameterKey=PublishedAssetHost,ParameterValue=${PUBLISHED_ASSET_HOST}"
  "ParameterKey=AgentRuntimeArn,ParameterValue=${AGENT_RUNTIME_ARN}"
  "ParameterKey=AgentCoreMemoryId,ParameterValue=${AGENTCORE_MEMORY_ID}"
  "ParameterKey=BackendFunctionExists,ParameterValue=${BACKEND_FUNCTION_EXISTS}"
)
echo "Parameters:"
printf '  %s\n' "${PARAMETERS[@]}"
echo ""

if [ ! -f "${TEMPLATE_FILE}" ]; then
  echo "ERROR: Template file not found: ${TEMPLATE_FILE}" >&2
  exit 1
fi

aws cloudformation validate-template \
  --template-body "file://${TEMPLATE_FILE}" \
  --region "${REGION}" > /dev/null

echo "  Template is valid."
echo ""

# ============================================================
# Deploy stack
# ============================================================
echo "--- Deploying stack to ${REGION} ---"

STACK_EXISTS=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_NAME}" \
  --region "${REGION}" \
  --query "Stacks[0].StackStatus" \
  --output text 2>/dev/null || echo "DOES_NOT_EXIST")

if [ "${STACK_EXISTS}" = "ROLLBACK_COMPLETE" ] || [ "${STACK_EXISTS}" = "CREATE_FAILED" ]; then
  echo "Stack is in ${STACK_EXISTS} state. Deleting and recreating..."
  aws cloudformation delete-stack \
    --stack-name "${STACK_NAME}" \
    --region "${REGION}"
  echo "Waiting for stack deletion..."
  aws cloudformation wait stack-delete-complete \
    --stack-name "${STACK_NAME}" \
    --region "${REGION}"
  STACK_EXISTS="DOES_NOT_EXIST"
fi

if [ "${STACK_EXISTS}" = "DOES_NOT_EXIST" ]; then
  echo "Creating new stack: ${STACK_NAME}..."
  aws cloudformation create-stack \
    --stack-name "${STACK_NAME}" \
    --region "${REGION}" \
    --template-body "file://${TEMPLATE_FILE}" \
    --parameters "${PARAMETERS[@]}" \
    --capabilities CAPABILITY_NAMED_IAM \
    --tags Key=Project,Value=makeui Key=system,Value=makeui

  echo "Waiting for stack creation to complete..."
  aws cloudformation wait stack-create-complete \
    --stack-name "${STACK_NAME}" \
    --region "${REGION}"
else
  # An update is shown before it is made, and made only on a yes.
  #
  # This used to be `update-stack` straight through, and on 2026-09-16 that
  # would have been an outage: the stack had not been updated since 08-01,
  # production had been fixed by hand since, and CloudFormation re-sends every
  # property of a resource it modifies — the Lambda's placeholder handler, the
  # role's old policies, the distribution without its sandbox. A change set
  # names what will be sent; reading it is the only place that shows up. And a
  # failure no longer rolls back, because a rollback re-sends the PREVIOUS
  # template's properties, which for a drifted resource is the same damage.
  CHANGE_SET="deploy-$(date +%Y%m%d-%H%M%S)"
  echo "Creating change set ${CHANGE_SET}..."
  aws cloudformation create-change-set \
    --stack-name "${STACK_NAME}" \
    --region "${REGION}" \
    --change-set-name "${CHANGE_SET}" \
    --template-body "file://${TEMPLATE_FILE}" \
    --parameters "${PARAMETERS[@]}" \
    --capabilities CAPABILITY_NAMED_IAM \
    --tags Key=Project,Value=makeui Key=system,Value=makeui > /dev/null

  if ! aws cloudformation wait change-set-create-complete \
      --stack-name "${STACK_NAME}" --region "${REGION}" --change-set-name "${CHANGE_SET}" 2>/dev/null; then
    REASON=$(aws cloudformation describe-change-set --stack-name "${STACK_NAME}" --region "${REGION}" \
      --change-set-name "${CHANGE_SET}" --query StatusReason --output text)
    aws cloudformation delete-change-set --stack-name "${STACK_NAME}" --region "${REGION}" --change-set-name "${CHANGE_SET}"
    if echo "${REASON}" | grep -qE "didn't contain changes|No updates are to be performed"; then
      echo "Stack already up to date."
    else
      echo "ERROR: change set failed: ${REASON}" >&2
      exit 1
    fi
  else
    aws cloudformation describe-change-set --stack-name "${STACK_NAME}" --region "${REGION}" \
      --change-set-name "${CHANGE_SET}" --include-property-values --output json | python3 -c '
import json, sys
d = json.load(sys.stdin)
for c in d["Changes"]:
    r = c["ResourceChange"]
    action, lid, rtype = r["Action"], r["LogicalResourceId"], r["ResourceType"]
    flag = ""
    if r.get("Replacement") in ("True", "Conditional"):
        flag = "   <-- REPLACEMENT " + r["Replacement"]
    if action == "Remove" and r.get("PolicyAction") != "Retain":
        flag = "   <-- DELETES the resource"
    print("%-7s %s (%s)%s" % (action, lid, rtype, flag))
    for x in r.get("Details", []):
        tg = x["Target"]
        where = tg.get("Path") or tg.get("Name") or tg["Attribute"]
        cause = x.get("CausingEntity") or x.get("ChangeSource", "")
        print("          %s  [%s, %s]" % (where, cause, x.get("Evaluation")))
        if tg.get("BeforeValue") is not None:
            print("            - " + tg["BeforeValue"][:300])
        if tg.get("AfterValue") is not None:
            print("            + " + tg["AfterValue"][:300])
'
    echo ""
    read -r -p "Execute change set ${CHANGE_SET} on ${STACK_NAME}? [y/N] " ANSWER
    if [ "${ANSWER}" != "y" ] && [ "${ANSWER}" != "Y" ]; then
      echo "Not executed. The change set is left for inspection; delete it with:"
      echo "  aws cloudformation delete-change-set --stack-name ${STACK_NAME} --region ${REGION} --change-set-name ${CHANGE_SET}"
      exit 1
    fi
    aws cloudformation execute-change-set \
      --stack-name "${STACK_NAME}" \
      --region "${REGION}" \
      --change-set-name "${CHANGE_SET}" \
      --disable-rollback

    echo "Waiting for stack update to complete..."
    if ! aws cloudformation wait stack-update-complete \
        --stack-name "${STACK_NAME}" --region "${REGION}"; then
      echo "ERROR: the update did not complete. Nothing was rolled back; see the stack events," >&2
      echo "fix the cause, and deploy again (or roll back deliberately with rollback-stack)." >&2
      exit 1
    fi
  fi
fi

echo ""
echo "Stack operation completed successfully!"
echo ""

# Retrieve outputs
echo "Retrieving stack outputs..."
OUTPUTS=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_NAME}" \
  --region "${REGION}" \
  --query "Stacks[0].Outputs" \
  --output json)

echo ""
echo "============================================================"
echo " Stack Outputs"
echo "============================================================"
echo "${OUTPUTS}" | python3 -c "
import json, sys
outputs = json.load(sys.stdin)
for o in outputs:
    print(f\"  {o['OutputKey']}: {o['OutputValue']}\")
"
echo ""

# Save key values to Parameter Store
echo "Saving outputs to Parameter Store..."

save_param() {
  local key="$1"
  local value="$2"
  aws ssm put-parameter \
    --name "/makeui/${key}" \
    --value "${value}" \
    --type String \
    --overwrite \
    --region "${REGION}" > /dev/null
  echo "  Saved: /makeui/${key}"
}

CLOUDFRONT_DOMAIN=$(echo "${OUTPUTS}" | python3 -c "import json,sys; print(next(o['OutputValue'] for o in json.load(sys.stdin) if o['OutputKey']=='CloudFrontDomainName'))")
CLOUDFRONT_DIST_ID=$(echo "${OUTPUTS}" | python3 -c "import json,sys; print(next(o['OutputValue'] for o in json.load(sys.stdin) if o['OutputKey']=='CloudFrontDistributionId'))")
FRONTEND_BUCKET=$(echo "${OUTPUTS}" | python3 -c "import json,sys; print(next(o['OutputValue'] for o in json.load(sys.stdin) if o['OutputKey']=='FrontendBucketName'))")
OUTPUTS_BUCKET=$(echo "${OUTPUTS}" | python3 -c "import json,sys; print(next(o['OutputValue'] for o in json.load(sys.stdin) if o['OutputKey']=='OutputsBucketName'))")
KB_BUCKET=$(echo "${OUTPUTS}" | python3 -c "import json,sys; print(next(o['OutputValue'] for o in json.load(sys.stdin) if o['OutputKey']=='KnowledgeBaseBucket'))")
TOKEN_TABLE=$(echo "${OUTPUTS}" | python3 -c "import json,sys; print(next(o['OutputValue'] for o in json.load(sys.stdin) if o['OutputKey']=='TokenUsageTable'))")
USER_POOL_ID=$(echo "${OUTPUTS}" | python3 -c "import json,sys; print(next(o['OutputValue'] for o in json.load(sys.stdin) if o['OutputKey']=='UserPoolId'))")
USER_POOL_CLIENT_ID=$(echo "${OUTPUTS}" | python3 -c "import json,sys; print(next(o['OutputValue'] for o in json.load(sys.stdin) if o['OutputKey']=='UserPoolClientId'))")

save_param "cloudfront-domain" "${CLOUDFRONT_DOMAIN}"
save_param "cloudfront-distribution-id" "${CLOUDFRONT_DIST_ID}"
save_param "frontend-bucket" "${FRONTEND_BUCKET}"
save_param "outputs-bucket" "${OUTPUTS_BUCKET}"
save_param "knowledge-base-bucket" "${KB_BUCKET}"
save_param "token-usage-table" "${TOKEN_TABLE}"
save_param "cognito/user-pool-id" "${USER_POOL_ID}"
save_param "cognito/client-id" "${USER_POOL_CLIENT_ID}"

echo ""
echo "============================================================"
echo " Deployment Complete!"
echo "============================================================"
echo ""
echo "CloudFront Domain: https://${CLOUDFRONT_DOMAIN}"
echo ""
echo "Next steps:"
echo "  1. Run ./setup-agentcore.sh to create AgentCore resources"
echo "  2. Run ./setup-knowledge-base.sh to create Knowledge Base"
echo "  3. Run ./setup-guardrails.sh to create Bedrock Guardrails"
echo "  4. Run ./setup-parameters.sh to set model & pipeline config"
echo "  5. Create Cognito user:"
echo "     aws cognito-idp admin-create-user --user-pool-id ${USER_POOL_ID} --username <email>"
echo "  6. (Optional) Add user to admin group:"
echo "     aws cognito-idp admin-add-user-to-group --user-pool-id ${USER_POOL_ID} --username <email> --group-name admin"
echo "  7. Build frontend and deploy to S3:"
echo "     cd ../frontend && npm run build"
echo "     aws s3 sync dist/ s3://${FRONTEND_BUCKET}/"
echo "     aws cloudfront create-invalidation --distribution-id ${CLOUDFRONT_DIST_ID} --paths '/*'"
echo ""
