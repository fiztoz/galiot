#!/usr/bin/env bash
#
# Real-server verification against an independent S3 implementation.
#
#   GALIOT_S3_KEY=… GALIOT_S3_SECRET=… ./scripts/live-s3-test.sh
#
# The caller supplies an ephemeral test credential through GALIOT_S3_KEY and
# GALIOT_S3_SECRET (see the one-liner in docs/OPERATIONS.md §7). Nothing is
# stored in this file or in the repo.
#
# Why not MinIO: as of 2026-11 the MinIO container images are no longer
# publicly pullable (quay.io answers 401, Docker Hub denies; the upstream
# repository was archived 2026-04-25). scripts/minio-test.sh remains for
# operators who still hold cached MinIO images. This script uses Zenko
# CloudServer (Scality), a separate S3 implementation that validates SigV4
# independently of Galiot's own signer.
#
# Runs the byte-integrity suite and the self-hosted server-path suite. The
# MinIO-quirk protocol suite (test:minio) is MinIO-specific and is not run here.
#
# Requirements: docker (colima or Docker Desktop), Bun, curl with --aws-sigv4,
# and the image docker.io/zenko/cloudserver.

set -euo pipefail

CONTAINER="galiot-live-s3-$$"
PORT="${GALIOT_MINIO_PORT:-9000}"
ENDPOINT="http://127.0.0.1:${PORT}"
BUCKET=galiot-test

if [ -z "${GALIOT_S3_KEY:-}" ] || [ -z "${GALIOT_S3_SECRET:-}" ]; then
  echo "Set GALIOT_S3_KEY and GALIOT_S3_SECRET to an ephemeral test credential." >&2
  exit 2
fi

# Map the caller's credential onto the image's expected variable names without
# writing credential assignments into this file.
for pair in "SCALITY_ACCESS_KEY_ID:GALIOT_S3_KEY" "SCALITY_SECRET_ACCESS_KEY:GALIOT_S3_SECRET"; do
  name="${pair%%:*}"
  source_var="${pair##*:}"
  export "${name}=${!source_var}"
done

cleanup() {
  echo ""
  echo "Removing ${CONTAINER}…"
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running. Start colima (colima start) or Docker Desktop first." >&2
  exit 2
fi

echo "Starting Zenko CloudServer on ${ENDPOINT}…"
docker run -d --name "${CONTAINER}" \
  -p "127.0.0.1:${PORT}:8000" \
  -e SCALITY_ACCESS_KEY_ID -e SCALITY_SECRET_ACCESS_KEY \
  -e REMOTE_MANAGEMENT_DISABLE=1 \
  docker.io/zenko/cloudserver:latest >/dev/null

sigv4() {
  curl --aws-sigv4 'aws:amz:us-east-1:s3' --user "${GALIOT_S3_KEY}:${GALIOT_S3_SECRET}" "$@"
}

for _ in $(seq 1 40); do
  if sigv4 -fsS "${ENDPOINT}/" >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! sigv4 -fsS "${ENDPOINT}/" >/dev/null 2>&1; then
  echo "CloudServer did not become healthy. Container log:" >&2
  docker logs --tail 30 "${CONTAINER}" >&2
  exit 1
fi
echo "CloudServer is healthy."

sigv4 -fsS -X PUT "${ENDPOINT}/${BUCKET}" >/dev/null
echo "Bucket ready: ${BUCKET}"

export GALIOT_S3_ENDPOINT="${ENDPOINT}"
export GALIOT_S3_REGION=us-east-1
export GALIOT_S3_PATH_STYLE=1
export GALIOT_S3_BUCKET="${BUCKET}"

echo ""
echo "=== transfer integrity (bytes survive) ==="
bun run test:integrity

echo ""
echo "=== self-hosted server path (test:minio-server) ==="
bun run test:minio-server

echo ""
echo "Both suites passed against a real, independent S3 implementation."
