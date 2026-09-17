#!/bin/bash
set -euo pipefail

# ============================================================
# MakeUI AI - Knowledge Base Setup
# ============================================================
# Creates a Bedrock Knowledge Base (RAG) and
# indexes the design system documents stored in S3.
# ============================================================

REGION="ap-northeast-1"
# The `-s3v` suffix is load-bearing in an account that has run the old version of
# this script. The reuse check below matches on name, and the OpenSearch-backed
# `makeui-design-kb` may still exist while a rollback path is being kept open —
# matching that name would quietly re-adopt the store this script was changed to
# stop creating, and the bill would come back without anything appearing to fail.
KB_NAME="makeui-design-kb-s3v"
EMBEDDING_MODEL="amazon.titan-embed-text-v2:0"

echo "============================================================"
echo " MakeUI AI - Knowledge Base Setup"
echo "============================================================"
echo ""

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
KB_BUCKET="makeui-knowledge-base-${ACCOUNT_ID}"
KB_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/makeui-kb-role"

echo "Account:    ${ACCOUNT_ID}"
echo "Region:     ${REGION}"
echo "Bucket:     ${KB_BUCKET}"
echo "Role:       ${KB_ROLE_ARN}"
echo ""

# ============================================================
# Verify prerequisite: KB role must exist (created by setup-agentcore.sh)
# ============================================================
if ! aws iam get-role --role-name makeui-kb-role >/dev/null 2>&1; then
  echo "ERROR: IAM role 'makeui-kb-role' does not exist." >&2
  echo "Please run ./setup-agentcore.sh first to create required roles." >&2
  exit 1
fi

# ============================================================
# IAM Policy for KB Role
# ============================================================
echo "--- Attaching policies to KB role ---"

KB_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::${KB_BUCKET}",
        "arn:aws:s3:::${KB_BUCKET}/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel"
      ],
      "Resource": "arn:aws:bedrock:${REGION}::foundation-model/${EMBEDDING_MODEL}"
    }
  ]
}
EOF
)

aws iam put-role-policy \
  --role-name makeui-kb-role \
  --policy-name makeui-kb-access \
  --policy-document "${KB_POLICY}"

# Update trust policy to allow bedrock.amazonaws.com
TRUST_POLICY=$(cat <<'EOF'
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
          "aws:SourceAccount": "ACCOUNT_ID_PLACEHOLDER"
        }
      }
    }
  ]
}
EOF
)
TRUST_POLICY="${TRUST_POLICY//ACCOUNT_ID_PLACEHOLDER/$ACCOUNT_ID}"

aws iam update-assume-role-policy \
  --role-name makeui-kb-role \
  --policy-document "${TRUST_POLICY}"

echo "  Policies attached."
echo ""

# Wait for IAM propagation
echo "Waiting for IAM propagation..."
sleep 10

# ============================================================
# Create the S3 Vectors store (the Knowledge Base's vector index)
# ============================================================
#
# This used to create an OpenSearch Serverless collection, and that is why it
# no longer does.
#
#   AOSS bills per OCU-hour, not per query. A collection holds a minimum of one
#   indexing and one search OCU running continuously, so the meter runs whether
#   or not anyone generates anything, and there is no pause or scale-to-zero.
#   Measured in ap-northeast-1: $8.016/day indexing + $8.016/day search =
#   $16.03/day, about $480-500/month, every day from the day the KB was created.
#   What it was serving: 14 files, 33 KB. Storage billed $0.0000005/day — the
#   entire charge was for keeping the box switched on.
#
#   S3 Vectors bills for stored vectors and queries, with no idle cost, and
#   Bedrock speaks to it through the same Knowledge Base API.
#
# One behavioural difference matters and is handled in the application code:
# S3 Vectors rejects `stringContains` filters ("STRING_CONTAINS operation type
# is not supported for S3 Vectors"), supporting only `equals` and `listContains`.
# Retrieval therefore filters on a `preset` / `owner` metadata attribute carried
# by `<file>.metadata.json` sidecars, not on a substring of the source URI.
# `equals` works on both stores, which is what keeps a rollback possible.
echo "--- Creating S3 Vectors store ---"

VECTOR_BUCKET="makeui-kb-vectors"
VECTOR_INDEX="makeui-vectors"

if aws s3vectors get-vector-bucket --vector-bucket-name "${VECTOR_BUCKET}" --region "${REGION}" > /dev/null 2>&1; then
  echo "  Vector bucket already exists: ${VECTOR_BUCKET}"
else
  aws s3vectors create-vector-bucket \
    --vector-bucket-name "${VECTOR_BUCKET}" \
    --region "${REGION}" > /dev/null
  echo "  Created vector bucket: ${VECTOR_BUCKET}"
fi

if aws s3vectors get-index --vector-bucket-name "${VECTOR_BUCKET}" --index-name "${VECTOR_INDEX}" --region "${REGION}" > /dev/null 2>&1; then
  echo "  Vector index already exists: ${VECTOR_INDEX}"
else
  # 1024 dimensions is Titan Embed Text v2's default output size; cosine matches
  # what the retrieval scores assume. Both are fixed at index creation.
  # AMAZON_BEDROCK_TEXT holds the chunk text and must not be filterable — it is
  # payload, not a facet, and leaving it filterable wastes index budget.
  aws s3vectors create-index \
    --vector-bucket-name "${VECTOR_BUCKET}" \
    --index-name "${VECTOR_INDEX}" \
    --data-type float32 \
    --dimension 1024 \
    --distance-metric cosine \
    --metadata-configuration '{"nonFilterableMetadataKeys":["AMAZON_BEDROCK_TEXT"]}' \
    --region "${REGION}" > /dev/null
  echo "  Created vector index: ${VECTOR_INDEX}"
fi

VECTOR_INDEX_ARN="arn:aws:s3vectors:${REGION}:${ACCOUNT_ID}:bucket/${VECTOR_BUCKET}/index/${VECTOR_INDEX}"
echo "  Index ARN: ${VECTOR_INDEX_ARN}"

KB_S3V_POLICY=$(cat <<EOFPOLICY
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3vectors:GetIndex",
        "s3vectors:ListIndexes",
        "s3vectors:PutVectors",
        "s3vectors:GetVectors",
        "s3vectors:QueryVectors",
        "s3vectors:DeleteVectors",
        "s3vectors:ListVectors",
        "s3vectors:GetVectorBucket"
      ],
      "Resource": [
        "arn:aws:s3vectors:${REGION}:${ACCOUNT_ID}:bucket/${VECTOR_BUCKET}",
        "arn:aws:s3vectors:${REGION}:${ACCOUNT_ID}:bucket/${VECTOR_BUCKET}/index/*"
      ]
    }
  ]
}
EOFPOLICY
)
aws iam put-role-policy \
  --role-name makeui-kb-role \
  --policy-name makeui-kb-s3vectors \
  --policy-document "${KB_S3V_POLICY}"
echo "  S3 Vectors access policy attached to KB role."
echo ""

# ============================================================
# Create Knowledge Base
# ============================================================
echo "--- Creating Knowledge Base ---"

EXISTING_KB_ID=$(aws bedrock-agent list-knowledge-bases \
  --region "${REGION}" \
  --query "knowledgeBaseSummaries[?name=='${KB_NAME}'].knowledgeBaseId" \
  --output text 2>/dev/null || echo "")

if [ -n "${EXISTING_KB_ID}" ] && [ "${EXISTING_KB_ID}" != "None" ]; then
  echo "  Knowledge Base already exists: ${EXISTING_KB_ID}"
  KB_ID="${EXISTING_KB_ID}"
else
  KB_ID=$(aws bedrock-agent create-knowledge-base \
    --region "${REGION}" \
    --name "${KB_NAME}" \
    --description "Design system documentation for UI generation" \
    --role-arn "${KB_ROLE_ARN}" \
    --knowledge-base-configuration "{
      \"type\": \"VECTOR\",
      \"vectorKnowledgeBaseConfiguration\": {
        \"embeddingModelArn\": \"arn:aws:bedrock:${REGION}::foundation-model/${EMBEDDING_MODEL}\"
      }
    }" \
    --storage-configuration "{
      \"type\": \"S3_VECTORS\",
      \"s3VectorsConfiguration\": {
        \"indexArn\": \"${VECTOR_INDEX_ARN}\"
      }
    }" \
    --query "knowledgeBase.knowledgeBaseId" \
    --output text)

  echo "  Created Knowledge Base: ${KB_ID}"
  echo "  Waiting for Knowledge Base to be active..."
  sleep 30
fi

echo ""

# ============================================================
# Create Data Source
# ============================================================
echo "--- Creating Data Source ---"

EXISTING_DS=$(aws bedrock-agent list-data-sources \
  --region "${REGION}" \
  --knowledge-base-id "${KB_ID}" \
  --query "dataSourceSummaries[0].dataSourceId" \
  --output text 2>/dev/null || echo "None")

if [ "${EXISTING_DS}" != "None" ] && [ -n "${EXISTING_DS}" ]; then
  echo "  Data source already exists: ${EXISTING_DS}"
  DS_ID="${EXISTING_DS}"
else
  DS_ID=$(aws bedrock-agent create-data-source \
    --region "${REGION}" \
    --knowledge-base-id "${KB_ID}" \
    --name "design-system-s3" \
    --description "Design system documents from S3" \
    --data-source-configuration "{
      \"type\": \"S3\",
      \"s3Configuration\": {
        \"bucketArn\": \"arn:aws:s3:::${KB_BUCKET}\"
      }
    }" \
    --vector-ingestion-configuration "{
      \"chunkingConfiguration\": {
        \"chunkingStrategy\": \"FIXED_SIZE\",
        \"fixedSizeChunkingConfiguration\": {
          \"maxTokens\": 512,
          \"overlapPercentage\": 20
        }
      }
    }" \
    --query "dataSource.dataSourceId" \
    --output text)

  echo "  Created Data Source: ${DS_ID}"
fi

echo ""

# ============================================================
# Upload sample design system documents
# ============================================================
echo "--- Uploading design system documents ---"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DOCS_DIR="${SCRIPT_DIR}/../knowledge-base-docs"

if [ -d "${DOCS_DIR}" ]; then
  # --delete: the repository is the corpus, so a preset removed from it leaves the index too.
  aws s3 sync "${DOCS_DIR}/" "s3://${KB_BUCKET}/" --region "${REGION}" --delete
  echo "  Uploaded documents from ${DOCS_DIR}"
else
  echo "  No local documents found at ${DOCS_DIR}"

  # The documents live in the repository (knowledge-base-docs/); a checkout without
  # them has nothing to index, so say so rather than create empty placeholders for
  # preset names that may not exist.
  echo "  Expected one directory per preset: digital-agency, carbon, spindle, material3, shared"
fi

echo ""

# ============================================================
# Start Ingestion Job
# ============================================================
echo "--- Starting ingestion job ---"

INGESTION_JOB_ID=$(aws bedrock-agent start-ingestion-job \
  --region "${REGION}" \
  --knowledge-base-id "${KB_ID}" \
  --data-source-id "${DS_ID}" \
  --query "ingestionJob.ingestionJobId" \
  --output text)

echo "  Ingestion job started: ${INGESTION_JOB_ID}"
echo "  (Running in background — check status with command below)"
echo ""

# ============================================================
# Save to Parameter Store
# ============================================================
echo "--- Saving to Parameter Store ---"

aws ssm put-parameter \
  --name "/makeui/agentcore/knowledge-base-id" \
  --value "${KB_ID}" \
  --type String \
  --overwrite \
  --region "${REGION}" > /dev/null
echo "  Saved: /makeui/agentcore/knowledge-base-id = ${KB_ID}"

aws ssm put-parameter \
  --name "/makeui/agentcore/data-source-id" \
  --value "${DS_ID}" \
  --type String \
  --overwrite \
  --region "${REGION}" > /dev/null
echo "  Saved: /makeui/agentcore/data-source-id = ${DS_ID}"

echo ""
echo "============================================================"
echo " Knowledge Base Setup Complete!"
echo "============================================================"
echo ""
echo "Resources:"
echo "  Knowledge Base ID: ${KB_ID}"
echo "  Data Source ID:    ${DS_ID}"
echo "  S3 Bucket:         ${KB_BUCKET}"
echo "  Embedding Model:   ${EMBEDDING_MODEL}"
echo ""
echo "S3 directory structure:"
echo "  s3://${KB_BUCKET}/"
echo "    ├── digital-agency/    <- Digital Agency Design System"
echo "    ├── material-design/   <- Material Design Guidelines"
echo "    ├── apple-hig/         <- Apple Human Interface Guidelines"
echo "    ├── ant-design/        <- Ant Design Guidelines"
echo "    ├── tailwind-ui/       <- Tailwind UI Components"
echo "    ├── shared/            <- Shared Best Practices"
echo "    └── custom/            <- User Custom Design Systems"
echo ""
echo "Check ingestion status:"
echo "  aws bedrock-agent get-ingestion-job \\"
echo "    --knowledge-base-id ${KB_ID} \\"
echo "    --data-source-id ${DS_ID} \\"
echo "    --ingestion-job-id ${INGESTION_JOB_ID} \\"
echo "    --region ${REGION}"
echo ""
echo "Re-sync after adding documents:"
echo "  aws s3 sync ./knowledge-base-docs/ s3://${KB_BUCKET}/"
echo "  aws bedrock-agent start-ingestion-job \\"
echo "    --knowledge-base-id ${KB_ID} \\"
echo "    --data-source-id ${DS_ID} \\"
echo "    --region ${REGION}"
echo ""
