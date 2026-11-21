#!/usr/bin/env bash
#
# Real-server verification: starts MinIO in a container and runs both live
# suites against it, then removes the container.
#
#   ./scripts/minio-test.sh
#
# Why this exists: the unit suite cannot see provider behaviour. Every bug fixed
# in this pass — a rejected empty continuation-token, a double-encoded canonical
# URI, a missing Content-MD5, a bucket-CORS API that does not exist — was
# invisible to mocks and to Bun, and obvious the moment a real S3 server
# answered.
#
# Requirements: docker (colima or Docker Desktop), Bun, and the images
# quay.io/minio/minio + quay.io/minio/mc. MinIO no longer publishes to Docker
# Hub, so the quay.io paths are the ones that work.

set -euo pipefail

CONTAINER=galiot-minio-test
PORT="${GALIOT_MINIO_PORT:-9000}"
ROOT_USER=galiotadmin
ROOT_PASSWORD=galiotsecret123
ENDPOINT="http://127.0.0.1:${PORT}"
BUCKETS=(galiot-test galiot-protocol)

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

if docker ps -a --format '{{.Names}}' | grep -qx "${CONTAINER}"; then
  docker rm -f "${CONTAINER}" >/dev/null
fi

echo "Starting MinIO on ${ENDPOINT} (permissive CORS, so the suites can run)…"
docker run -d --name "${CONTAINER}" \
  -p "127.0.0.1:${PORT}:9000" -p "127.0.0.1:$((PORT + 1)):9001" \
  -e MINIO_ROOT_USER="${ROOT_USER}" \
  -e MINIO_ROOT_PASSWORD="${ROOT_PASSWORD}" \
  -e MINIO_API_CORS_ALLOW_ORIGIN='*' \
  quay.io/minio/minio:latest server /data --console-address ":9001" >/dev/null

# Wait for the health endpoint rather than sleeping a fixed amount.
for _ in $(seq 1 40); do
  if curl -fsS "${ENDPOINT}/minio/health/live" >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! curl -fsS "${ENDPOINT}/minio/health/live" >/dev/null 2>&1; then
  echo "MinIO did not become healthy. Container log:" >&2
  docker logs --tail 30 "${CONTAINER}" >&2
  exit 1
fi
echo "MinIO is healthy."

for bucket in "${BUCKETS[@]}"; do
  docker run --rm --network host \
    -e MC_HOST_galiot="http://${ROOT_USER}:${ROOT_PASSWORD}@127.0.0.1:${PORT}" \
    quay.io/minio/mc:latest mb --ignore-existing "galiot/${bucket}" >/dev/null
done
echo "Buckets ready: ${BUCKETS[*]}"

export GALIOT_S3_ENDPOINT="${ENDPOINT}"
export GALIOT_S3_KEY="${ROOT_USER}"
export GALIOT_S3_SECRET="${ROOT_PASSWORD}"
export GALIOT_S3_REGION=us-east-1
export GALIOT_S3_PATH_STYLE=1

echo ""
echo "=== transfer integrity (bytes survive) ==="
GALIOT_S3_BUCKET=galiot-test bun run test:integrity

echo ""
echo "=== real-server protocol behaviour (test:minio) ==="
GALIOT_S3_BUCKET=galiot-protocol bun run test:minio

echo ""
echo "=== self-hosted server path (test:minio-server) ==="
GALIOT_S3_BUCKET=galiot-test bun run test:minio-server

echo ""
echo "All three suites passed against a real S3 implementation."
