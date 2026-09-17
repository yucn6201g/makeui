#!/bin/bash
set -euo pipefail

# ============================================================
# MakeUI AI - Model & Preset Parameters Setup
# ============================================================
# Sets the SSM parameters the backend reads at runtime.
# Run this AFTER deploy.sh and setup-agentcore.sh.
#
# Every parameter written here is read by src/config/agentcore-config.ts.
# Nothing else belongs in this file: parameters whose reader has been deleted
# are dead weight that later reads as configuration, and this script had three
# of them (pipeline/mode, pipeline/quality-threshold, pipeline/max-refinements)
# plus presets/available long after their callers were gone.
# ============================================================

REGION="ap-northeast-1"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"

echo "============================================================"
echo " MakeUI AI - Model & Preset Parameters Setup"
echo "============================================================"
echo ""

save_param() {
  local key="$1"
  local value="$2"
  aws ssm put-parameter \
    --name "/makeui/${key}" \
    --value "${value}" \
    --type String \
    --overwrite \
    --region "${REGION}" > /dev/null
  echo "  Saved: /makeui/${key} = ${value}"
}

# ============================================================
# Model Configuration
# ============================================================
# Full inference-profile ARNs, not bare model ids. resolveModel() passes the
# value straight to Bedrock as modelId, and a cross-region profile has to be
# addressed by ARN — the bare ids this script used to write are rejected with
# "The provided model identifier is invalid".
echo "--- Model Configuration ---"

PROFILE="arn:aws:bedrock:${REGION}:${ACCOUNT_ID}:inference-profile"

save_param "models/sonnet"  "${PROFILE}/jp.anthropic.claude-sonnet-4-6"
save_param "models/opus"    "${PROFILE}/jp.anthropic.claude-opus-4-8"
save_param "models/haiku"   "${PROFILE}/jp.anthropic.claude-haiku-4-5-20251001-v1:0"
# The default is resolved the same way as an explicit choice, so it holds an ARN
# too — it used to hold the literal string "sonnet", which is not a model id.
save_param "models/default" "${PROFILE}/jp.anthropic.claude-sonnet-4-6"

echo ""

# ============================================================
# Presets Configuration
# ============================================================
# One kb-prefix per preset that PRESET_SPECS defines. The list had drifted to
# an older set (material-design / apple-hig / ant-design / tailwind-ui) that no
# longer exists in the app, while none of the presets the app actually offers
# were written at all — a fresh account came up with unresolvable presets.
echo "--- Presets Configuration ---"

# digital-agency, carbon, spindle and material3 since 2026-09-14; the five styles written
# for the app (product, editorial, warm, console, wireframe) were removed.
for preset in digital-agency carbon spindle material3; do
  save_param "presets/${preset}/kb-prefix" "${preset}/"
done

echo ""
echo "============================================================"
echo " Parameters Setup Complete!"
echo "============================================================"
echo ""
echo "To point a tier at a different model:"
echo "  aws ssm put-parameter --name /makeui/models/sonnet --value <inference-profile-arn> --type String --overwrite --region ${REGION}"
echo ""
