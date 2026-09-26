#!/bin/bash
set -euo pipefail

# ============================================================
# MakeUI AI - Frontend Deployment (S3 + CloudFront)
# ============================================================
#
# Why this exists rather than a plain `aws s3 sync`:
#
#   A plain sync uploads `index.html` with NO `Cache-Control` header. S3 sets
#   none by default, so browsers fall back to heuristic freshness and CloudFront
#   to its 24-hour default TTL — and the entry point of a single-page app is the
#   one file that must never be cached. The symptom is that a deploy appears to
#   succeed, the invalidation completes, the bucket holds the new bundle, and
#   users keep running the old one: their cached `index.html` still names the
#   previous hashed bundle, so they never request the new one at all. Measured:
#   a fixed preview bug was reported as still broken hours after the fix was
#   live, and the served `index.html` carried no `Cache-Control` at all.
#
#   The hashed assets want the opposite treatment. Their names contain a content
#   hash, so a given URL's bytes never change and they can be cached for a year.
#   Leaving them uncached costs a re-download of several megabytes per visit.
#
#   Two files, two opposite policies, and getting either backwards is invisible
#   until someone reports a fix that "did not work".
# ============================================================

REGION="ap-northeast-1"
# Per deployment, so read from SSM (written by deploy.sh) unless given.
DISTRIBUTION_ID="${DISTRIBUTION_ID:-$(MSYS_NO_PATHCONV=1 aws ssm get-parameter --name /makeui/cloudfront-distribution-id --region "${REGION}" --query Parameter.Value --output text)}"
if [ -z "${DISTRIBUTION_ID}" ] || [ "${DISTRIBUTION_ID}" = "None" ]; then
  echo "ERROR: no CloudFront distribution id (SSM /makeui/cloudfront-distribution-id). Set DISTRIBUTION_ID and re-run." >&2
  exit 1
fi
# How long a tab opened before a deploy keeps working. Generous on purpose: the
# cost of retaining a few megabytes of dead JavaScript is nothing next to a user
# hitting a broken lazy import.
PRUNE_DAYS="${PRUNE_DAYS:-30}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRONTEND_DIR="$(cd "${SCRIPT_DIR}/../frontend" && pwd)"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
BUCKET="makeui-frontend-${ACCOUNT_ID}"

echo "============================================================"
echo " MakeUI frontend deployment"
echo "  bucket:       ${BUCKET}"
echo "  distribution: ${DISTRIBUTION_ID}"
echo "============================================================"

cd "${FRONTEND_DIR}"

# SKIP_BUILD is set by the CI pipeline, where the build stage has already run
# both test suites and produced dist/. Running them again here would double the
# deploy time and, worse, would test a tree that is not the one being deployed.
if [ "${SKIP_BUILD:-}" = "1" ]; then
  echo "--- Using dist/ from the build stage (SKIP_BUILD=1) ---"
  test -s dist/index.html || { echo "dist/index.html is missing"; exit 1; }
else
  echo "--- Testing ---"
  npm test

  echo "--- Building ---"
  npm run build
fi

LOCAL_ENTRY=$(grep -o 'assets/index-[A-Za-z0-9_-]*\.js' dist/index.html | head -1)
echo "  built entry: ${LOCAL_ENTRY}"

# Assets first, and index.html last. In that order a visitor who loads the page
# mid-deploy either gets the whole old version or the whole new one; the reverse
# order leaves a window where the new index.html names a bundle not yet uploaded.
echo "--- Uploading assets (immutable, 1 year) ---"
aws s3 sync dist/ "s3://${BUCKET}/" \
  --exclude "index.html" \
  --cache-control "public, max-age=31536000, immutable" \
  --region "${REGION}" --only-show-errors

echo "--- Uploading index.html (no-cache) ---"
aws s3 cp dist/index.html "s3://${BUCKET}/index.html" \
  --cache-control "no-cache, must-revalidate" \
  --content-type "text/html; charset=utf-8" \
  --region "${REGION}" --only-show-errors

# The previous build's assets are KEPT. This is not untidiness.
#
#   A loaded page holds the chunk names of the build it came from, and it fetches
#   some of them lazily — the runtimes and the Vue compiler are dynamic imports, so
#   they are requested at the moment someone previews a project, which can be
#   long after the tab was opened. Deleting the old files pulls them out from
#   under every open tab.
#
#   And the failure is disguised. This distribution maps 404 to /index.html with
#   status 200 so client-side routes work, so a missing chunk does not 404 — it
#   returns an HTML document where the browser expected JavaScript, and reports
#   `Failed to fetch dynamically imported module`. Measured: exactly that, on a
#   Svelte preview, from a tab opened before a deploy.
#
#   Hashed names never collide, so keeping them is free of risk and nearly free
#   of cost. Only genuinely old files, no longer part of any recent build, are
#   pruned — and never a file the current build still references, because an
#   unchanged file keeps its original LastModified and `sync` will not have
#   re-uploaded it.
echo "--- Pruning assets older than ${PRUNE_DAYS} days (keeping the current build) ---"
CURRENT=$(cd dist && find . -type f | sed 's|^\./||')
CUTOFF=$(python -c "
import datetime, sys
print((datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=${PRUNE_DAYS})).isoformat())
")
aws s3api list-objects-v2 --bucket "${BUCKET}" --prefix assets/ --region "${REGION}" \
  --query "Contents[?LastModified<'${CUTOFF}'].Key" --output text 2>/dev/null | tr '\t' '\n' | while read -r key; do
  [ -z "${key}" ] && continue
  if echo "${CURRENT}" | grep -qxF "${key}"; then continue; fi
  echo "  pruning ${key}"
  aws s3 rm "s3://${BUCKET}/${key}" --region "${REGION}" --only-show-errors
done

echo "--- Invalidating CloudFront ---"
aws cloudfront create-invalidation \
  --distribution-id "${DISTRIBUTION_ID}" \
  --paths '/*' \
  --query 'Invalidation.Id' --output text

echo "--- Verifying what is actually served ---"
DOMAIN=$(aws cloudfront get-distribution --id "${DISTRIBUTION_ID}" --query 'Distribution.DomainName' --output text)
# The invalidation is asynchronous, so this can legitimately lag by a few
# seconds; it is a report, not a gate.
sleep 5
SERVED_ENTRY=$(curl -s "https://${DOMAIN}/index.html" | grep -o 'assets/index-[A-Za-z0-9_-]*\.js' | head -1 || echo "")
CACHE_HDR=$(curl -s -D - -o /dev/null "https://${DOMAIN}/index.html" | grep -i '^cache-control' | tr -d '\r' || echo "(none)")

echo "  local entry : ${LOCAL_ENTRY}"
echo "  served entry: ${SERVED_ENTRY:-(could not read)}"
echo "  index.html  : ${CACHE_HDR}"

if [ -z "${CACHE_HDR}" ] || [ "${CACHE_HDR}" = "(none)" ]; then
  echo ""
  echo "WARNING: index.html is served with no Cache-Control. Users will keep"
  echo "         running whatever bundle their browser already cached."
  exit 1
fi
if [ -n "${SERVED_ENTRY}" ] && [ "${SERVED_ENTRY}" != "${LOCAL_ENTRY}" ]; then
  echo ""
  echo "NOTE: the edge is still serving the previous entry. The invalidation is"
  echo "      asynchronous — re-check in a minute before assuming a failure."
fi

echo ""
echo "DEPLOYED - and note that an already-open tab keeps its loaded bundle until"
echo "           it is reloaded. A single-page app does not re-fetch index.html"
echo "           on its own, so 'still broken' after a deploy is worth checking"
echo "           against a hard reload before treating it as a code defect."
