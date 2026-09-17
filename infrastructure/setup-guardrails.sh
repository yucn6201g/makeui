#!/bin/bash
set -euo pipefail

# ============================================================
# MakeUI AI - Bedrock Guardrails Setup
# ============================================================

REGION="ap-northeast-1"
GUARDRAIL_NAME="makeui-guardrail"

echo "============================================================"
echo " MakeUI AI - Bedrock Guardrails Setup"
echo "============================================================"
echo ""

# ============================================================
# Create Guardrail (idempotent)
# ============================================================
echo "Creating Bedrock Guardrail..."

# Check if guardrail already exists
EXISTING_GUARDRAIL_ID=$(aws bedrock list-guardrails \
  --region "${REGION}" \
  --query "guardrails[?name=='${GUARDRAIL_NAME}'].guardrailId | [0]" \
  --output text 2>/dev/null || echo "None")

if [ "${EXISTING_GUARDRAIL_ID}" != "None" ] && [ -n "${EXISTING_GUARDRAIL_ID}" ]; then
  echo "  Guardrail already exists: ${EXISTING_GUARDRAIL_ID}"
  GUARDRAIL_ID="${EXISTING_GUARDRAIL_ID}"

  # Get the latest published (numeric) version; exclude DRAFT
  GUARDRAIL_VERSION=$(aws bedrock list-guardrails \
    --region "${REGION}" \
    --guardrail-identifier "${GUARDRAIL_ID}" \
    --query "guardrails[?version!='DRAFT'] | [-1].version" \
    --output text 2>/dev/null || echo "1")
  # If no published version exists yet, fall back to "1"
  if [ -z "${GUARDRAIL_VERSION}" ] || [ "${GUARDRAIL_VERSION}" = "None" ]; then
    GUARDRAIL_VERSION="1"
  fi
  echo "  Guardrail Version: ${GUARDRAIL_VERSION}"
else
  GUARDRAIL_RESPONSE=$(aws bedrock create-guardrail \
    --region "${REGION}" \
    --name "${GUARDRAIL_NAME}" \
    --description "Content safety guardrail for MakeUI AI application" \
    --content-policy-config '{
      "filtersConfig": [
        {
          "type": "SEXUAL",
          "inputStrength": "HIGH",
          "outputStrength": "HIGH"
        },
        {
          "type": "VIOLENCE",
          "inputStrength": "HIGH",
          "outputStrength": "HIGH"
        },
        {
          "type": "HATE",
          "inputStrength": "HIGH",
          "outputStrength": "HIGH"
        },
        {
          "type": "INSULTS",
          "inputStrength": "HIGH",
          "outputStrength": "HIGH"
        },
        {
          "type": "MISCONDUCT",
          "inputStrength": "HIGH",
          "outputStrength": "HIGH"
        },
        {
          "type": "PROMPT_ATTACK",
          "inputStrength": "HIGH",
          "outputStrength": "NONE"
        }
      ]
    }' \
    --sensitive-information-policy-config '{
      "piiEntitiesConfig": [
        {
          "type": "EMAIL",
          "action": "ANONYMIZE"
        },
        {
          "type": "PHONE",
          "action": "ANONYMIZE"
        },
        {
          "type": "NAME",
          "action": "ANONYMIZE"
        },
        {
          "type": "CREDIT_DEBIT_CARD_NUMBER",
          "action": "BLOCK"
        }
      ]
    }' \
    --blocked-input-messaging "Sorry, I cannot process this request due to content policy restrictions." \
    --blocked-outputs-messaging "Sorry, I cannot provide this response due to content policy restrictions." \
    --tags key=Project,value=makeui \
    --output json)

  GUARDRAIL_ID=$(echo "${GUARDRAIL_RESPONSE}" | python3 -c "import json,sys; print(json.load(sys.stdin)['guardrailId'])")
  echo "  Guardrail ID: ${GUARDRAIL_ID}"
  echo ""

  # ============================================================
  # Create Guardrail Version
  # ============================================================
  echo "Creating guardrail version..."

  VERSION_RESPONSE=$(aws bedrock create-guardrail-version \
    --region "${REGION}" \
    --guardrail-identifier "${GUARDRAIL_ID}" \
    --description "Initial production version" \
    --output json)

  GUARDRAIL_VERSION=$(echo "${VERSION_RESPONSE}" | python3 -c "import json,sys; print(json.load(sys.stdin)['version'])")
  echo "  Guardrail Version: ${GUARDRAIL_VERSION}"
fi
echo ""

# ============================================================
# Save to Parameter Store
# ============================================================
echo "Saving guardrail configuration to Parameter Store..."

aws ssm put-parameter \
  --name "/makeui/guardrail-id" \
  --value "${GUARDRAIL_ID}" \
  --type String \
  --overwrite \
  --region "${REGION}" > /dev/null
echo "  Saved: /makeui/guardrail-id"

aws ssm put-parameter \
  --name "/makeui/guardrail-version" \
  --value "${GUARDRAIL_VERSION}" \
  --type String \
  --overwrite \
  --region "${REGION}" > /dev/null
echo "  Saved: /makeui/guardrail-version"

echo ""
echo "============================================================"
echo " Guardrails Setup Complete!"
echo "============================================================"
echo ""
echo "Guardrail ID:      ${GUARDRAIL_ID}"
echo "Guardrail Version: ${GUARDRAIL_VERSION}"
echo ""
echo "Content Filters:"
echo "  - SEXUAL:        HIGH / HIGH"
echo "  - VIOLENCE:      HIGH / HIGH"
echo "  - HATE:          HIGH / HIGH"
echo "  - INSULTS:       HIGH / HIGH"
echo "  - MISCONDUCT:    HIGH / HIGH"
echo "  - PROMPT_ATTACK: HIGH / NONE"
echo ""
echo "PII Configuration:"
echo "  - EMAIL:         ANONYMIZE"
echo "  - PHONE:         ANONYMIZE"
echo "  - NAME:          ANONYMIZE"
echo "  - CREDIT_CARD:   BLOCK"
echo ""
