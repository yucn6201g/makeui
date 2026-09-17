#!/bin/bash
set -euo pipefail

# ============================================================
# MakeUI AI - AgentCore Resources Setup
# ============================================================

REGION="ap-northeast-1"

echo "============================================================"
echo " MakeUI AI - AgentCore Resources Setup"
echo "============================================================"
echo ""

# Get AWS Account ID
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "Account ID: ${ACCOUNT_ID}"
echo "Region:     ${REGION}"
echo ""

# ============================================================
# IAM Roles
# ============================================================
echo "Creating IAM roles..."

TRUST_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "bedrock-agentcore.amazonaws.com"
      },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": {
          "aws:SourceAccount": "${ACCOUNT_ID}"
        }
      }
    }
  ]
}
EOF
)

# Helper function: create role if it does not already exist
create_role_if_not_exists() {
  local role_name="$1"
  local trust_doc="$2"
  if aws iam get-role --role-name "${role_name}" >/dev/null 2>&1; then
    echo "    Role ${role_name} already exists, skipping."
  else
    aws iam create-role \
      --role-name "${role_name}" \
      --assume-role-policy-document "${trust_doc}" \
      --tags Key=Project,Value=makeui > /dev/null
    echo "    Created ${role_name}."
  fi
}

# Memory Role
echo "  Creating memory-role..."
create_role_if_not_exists "makeui-memory-role" "${TRUST_POLICY}"

# Runtime Role
echo "  Creating runtime-role..."
create_role_if_not_exists "makeui-runtime-role" "${TRUST_POLICY}"

# Gateway Role

# Knowledge Base Role (uses bedrock.amazonaws.com, not agentcore)
echo "  Creating kb-role..."
KB_TRUST_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "bedrock.amazonaws.com"
      },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": {
          "aws:SourceAccount": "${ACCOUNT_ID}"
        }
      }
    }
  ]
}
EOF
)
create_role_if_not_exists "makeui-kb-role" "${KB_TRUST_POLICY}"

echo ""

# ============================================================
# Attach policies to runtime role
# ============================================================
echo "  Attaching policies to runtime-role..."

RUNTIME_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SSMReadAccess",
      "Effect": "Allow",
      "Action": [
        "ssm:GetParameter",
        "ssm:GetParameters"
      ],
      "Resource": "arn:aws:ssm:${REGION}:${ACCOUNT_ID}:parameter/makeui/*"
    },
    {
      "Sid": "DynamoDBAccess",
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:Query",
        "dynamodb:Scan"
      ],
      "Resource": [
        "arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/makeui-token-usage",
        "arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/makeui-token-usage/index/*"
      ]
    },
    {
      "Sid": "S3OutputsAccess",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject"
      ],
      "Resource": "arn:aws:s3:::makeui-outputs-${ACCOUNT_ID}/*"
    },
    {
      "Sid": "S3OutputsListAccess",
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket"
      ],
      "Resource": "arn:aws:s3:::makeui-outputs-${ACCOUNT_ID}"
    },
    {
      "Sid": "S3KBUploadAccess",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject"
      ],
      "Resource": "arn:aws:s3:::makeui-knowledge-base-${ACCOUNT_ID}/custom/*"
    },
    {
      "Sid": "BedrockInvokeModel",
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream"
      ],
      "Resource": [
        "arn:aws:bedrock:*::foundation-model/*",
        "arn:aws:bedrock:*:*:inference-profile/jp.anthropic.*"
      ]
    },
    {
      "Sid": "BedrockGuardrail",
      "Effect": "Allow",
      "Action": [
        "bedrock:ApplyGuardrail"
      ],
      "Resource": "arn:aws:bedrock:${REGION}:${ACCOUNT_ID}:guardrail/*"
    },
    {
      "Sid": "BedrockKBRetrieve",
      "Effect": "Allow",
      "Action": [
        "bedrock:Retrieve"
      ],
      "Resource": "arn:aws:bedrock:${REGION}:${ACCOUNT_ID}:knowledge-base/*"
    },
    {
      "Sid": "BedrockAgentCoreAccess",
      "Effect": "Allow",
      "Action": [
        "bedrock-agentcore:InvokeBrowser",
        "bedrock-agentcore:RetrieveMemoryRecords",
        "bedrock-agentcore:CreateMemoryRecord"
      ],
      "Resource": "*"
    }
  ]
}
EOF
)

aws iam put-role-policy \
  --role-name makeui-runtime-role \
  --policy-name makeui-runtime-access \
  --policy-document "${RUNTIME_POLICY}"

echo "  Runtime role policies attached."
echo ""

# ============================================================
# Attach policies to memory role
# ============================================================
echo "  Attaching policies to memory-role..."

MEMORY_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AgentCoreMemoryAccess",
      "Effect": "Allow",
      "Action": [
        "bedrock-agentcore:RetrieveMemoryRecords",
        "bedrock-agentcore:CreateMemoryRecord",
        "bedrock-agentcore:DeleteMemoryRecord"
      ],
      "Resource": "*"
    },
    {
      "Sid": "BedrockEmbedding",
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel"
      ],
      "Resource": "arn:aws:bedrock:${REGION}::foundation-model/amazon.titan-embed-*"
    }
  ]
}
EOF
)

aws iam put-role-policy \
  --role-name makeui-memory-role \
  --policy-name makeui-memory-access \
  --policy-document "${MEMORY_POLICY}"

echo "  Memory role policies attached."
echo ""

# Wait for IAM role propagation before using roles in other services
echo "Waiting for IAM propagation (10s)..."
sleep 10

# ============================================================
# AgentCore Memory
# ============================================================
echo "Creating AgentCore Memory..."

MEMORY_CONFIG=$(cat <<EOF
{
  "name": "makeui-memory",
  "strategies": [
    {
      "strategyName": "UserPreferences",
      "type": "SEMANTIC",
      "configuration": {
        "description": "Stores user design preferences, style choices, and workflow patterns"
      }
    },
    {
      "strategyName": "DesignContext",
      "type": "SEMANTIC",
      "configuration": {
        "description": "Stores design context including component libraries, design tokens, and project requirements"
      }
    }
  ]
}
EOF
)

MEMORY_ID=$(aws bedrock-agentcore-control create-memory \
  --region "${REGION}" \
  --cli-input-json "${MEMORY_CONFIG}" \
  --query "memoryId" \
  --output text 2>/dev/null || echo "ALREADY_EXISTS")

if [ "${MEMORY_ID}" = "ALREADY_EXISTS" ]; then
  echo "  Memory already exists, retrieving ID..."
  MEMORY_ID=$(aws bedrock-agentcore-control list-memories \
    --region "${REGION}" \
    --query "memories[?name=='makeui-memory'].memoryId" \
    --output text)
fi
echo "  Memory ID: ${MEMORY_ID}"
echo ""

# ============================================================
# Workload Identity
# ============================================================
echo "Creating Workload Identity..."

WORKLOAD_IDENTITY_CONFIG=$(cat <<EOF
{
  "name": "makeui-workload",
  "roleArn": "arn:aws:iam::${ACCOUNT_ID}:role/makeui-runtime-role"
}
EOF
)

WORKLOAD_ID=$(aws bedrock-agentcore-control create-workload-identity \
  --region "${REGION}" \
  --cli-input-json "${WORKLOAD_IDENTITY_CONFIG}" \
  --query "workloadIdentityId" \
  --output text 2>/dev/null || echo "ALREADY_EXISTS")

if [ "${WORKLOAD_ID}" = "ALREADY_EXISTS" ]; then
  echo "  Workload identity already exists, retrieving ID..."
  WORKLOAD_ID=$(aws bedrock-agentcore-control list-workload-identities \
    --region "${REGION}" \
    --query "workloadIdentities[?name=='makeui-workload'].workloadIdentityId" \
    --output text)
fi
echo "  Workload Identity ID: ${WORKLOAD_ID}"
echo ""

# ============================================================
# Browser Tool
# ============================================================
echo "Creating Browser tool..."

OUTPUTS_BUCKET=$(aws ssm get-parameter \
  --name "/makeui/outputs-bucket" \
  --region "${REGION}" \
  --query "Parameter.Value" \
  --output text 2>/dev/null || echo "makeui-outputs-${ACCOUNT_ID}")

BROWSER_CONFIG=$(cat <<EOF
{
  "name": "makeui-browser",
  "mode": "PUBLIC",
  "recordingsConfiguration": {
    "s3Bucket": "${OUTPUTS_BUCKET}",
    "s3Prefix": "browser-recordings/"
  }
}
EOF
)

BROWSER_ID=$(aws bedrock-agentcore-control create-browser \
  --region "${REGION}" \
  --cli-input-json "${BROWSER_CONFIG}" \
  --query "browserId" \
  --output text 2>/dev/null || echo "ALREADY_EXISTS")

if [ "${BROWSER_ID}" = "ALREADY_EXISTS" ]; then
  echo "  Browser already exists, retrieving ID..."
  BROWSER_ID=$(aws bedrock-agentcore-control list-browsers \
    --region "${REGION}" \
    --query "browsers[?name=='makeui-browser'].browserId" \
    --output text)
fi
echo "  Browser ID: ${BROWSER_ID}"
echo ""

# ============================================================
# Save to Parameter Store
# ============================================================
echo "Saving resource IDs to Parameter Store..."

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

save_param "agentcore/memory-id" "${MEMORY_ID}"
save_param "agentcore/workload-identity-id" "${WORKLOAD_ID}"
save_param "agentcore/browser-id" "${BROWSER_ID}"
save_param "agentcore/memory-role-arn" "arn:aws:iam::${ACCOUNT_ID}:role/makeui-memory-role"
save_param "agentcore/runtime-role-arn" "arn:aws:iam::${ACCOUNT_ID}:role/makeui-runtime-role"
save_param "agentcore/kb-role-arn" "arn:aws:iam::${ACCOUNT_ID}:role/makeui-kb-role"

echo ""
echo "============================================================"
echo " AgentCore Setup Complete!"
echo "============================================================"
echo ""
echo "Resources created:"
echo "  Memory:           ${MEMORY_ID}"
echo "  Workload Identity: ${WORKLOAD_ID}"
echo "  Browser:          ${BROWSER_ID}"
echo ""
echo "IAM Roles:"
echo "  Memory Role:      arn:aws:iam::${ACCOUNT_ID}:role/makeui-memory-role"
echo "  Runtime Role:     arn:aws:iam::${ACCOUNT_ID}:role/makeui-runtime-role"
echo "  KB Role:          arn:aws:iam::${ACCOUNT_ID}:role/makeui-kb-role"
echo ""
echo "Next steps:"
echo "  1. Run ./setup-knowledge-base.sh to create Knowledge Base"
echo "  2. Run ./setup-guardrails.sh to create Bedrock Guardrails"
echo "  3. Set SSM parameters for model config (see docs/03_configuration.md)"
echo ""
