#!/bin/bash
set -euo pipefail

# Usage: ./set-user-limit.sh <user-id> <monthly-token-limit>
# Example: ./set-user-limit.sh abc123-def456 500000

if [ $# -lt 2 ]; then
  echo "Usage: $0 <user-id> <monthly-token-limit>"
  echo ""
  echo "Examples:"
  echo "  $0 abc123-def456 500000    # 50万トークン/月"
  echo "  $0 abc123-def456 2000000   # 200万トークン/月"
  echo ""
  echo "To find user-id, check Cognito:"
  echo "  aws cognito-idp list-users --user-pool-id <pool-id> --filter 'email=\"user@example.com\"'"
  exit 1
fi

USER_ID="$1"
LIMIT="$2"
TABLE_NAME="${USAGE_TABLE_NAME:-makeui-token-usage}"
REGION="${AWS_REGION:-ap-northeast-1}"
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

echo "Setting token limit for user: ${USER_ID}"
echo "  Monthly limit: ${LIMIT} tokens"
echo "  Table: ${TABLE_NAME}"
echo ""

aws dynamodb put-item \
  --table-name "${TABLE_NAME}" \
  --item "{
    \"pk\": {\"S\": \"USER#${USER_ID}\"},
    \"sk\": {\"S\": \"CONFIG\"},
    \"monthlyTokenLimit\": {\"N\": \"${LIMIT}\"},
    \"updatedAt\": {\"S\": \"${NOW}\"}
  }" \
  --region "${REGION}"

echo "Done. User ${USER_ID} monthly limit set to ${LIMIT} tokens."
