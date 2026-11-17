# Self-hosted image. The process calls S3, so the host must be able to reach
# the bucket. A public bind requires GALIOT_PROXY_TOKEN or GALIOT_GATE at
# runtime (the server refuses to start without one). Do not bake the gate into
# the image.
FROM oven/bun:1.4.2
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build
ENV GALIOT_HOST=0.0.0.0
ENV GALIOT_PORT=8788
EXPOSE 8788
CMD ["bun", "run", "server"]
