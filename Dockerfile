# Self-hosted image. The process calls S3, so the host must be able to reach
# the bucket. A public bind requires GALIOT_PROXY_TOKEN or GALIOT_GATE at
# runtime (the server refuses to start without one). Do not bake the gate into
# the image.
FROM oven/bun:1.4.2 AS base
WORKDIR /app

FROM base AS build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY index.html vite.config.ts tsconfig.json ./
COPY src/ ./src/
COPY public/ ./public/
COPY scripts/server.ts scripts/copy-pdfjs-assets.ts ./scripts/
RUN bun run build
RUN bun build scripts/server.ts --target=bun --outfile=server.js

FROM base
COPY --from=build /app/dist ./dist
# The server resolves ../dist relative to its entry point.
COPY --from=build /app/server.js ./scripts/server.js
COPY LICENSE ./
ENV GALIOT_HOST=0.0.0.0
ENV GALIOT_PORT=8788
EXPOSE 8788
# The base image ships an unprivileged `bun` user (uid 1000, matching the chart).
USER bun
# Liveness: the health endpoint answers without touching S3.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.GALIOT_PORT||'8788')+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "./scripts/server.js"]
