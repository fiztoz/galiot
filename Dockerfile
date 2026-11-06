# Provider-neutral image. Any host that runs containers can serve Galiot.
# A public bind requires GALIOT_PROXY_TOKEN at runtime (the server refuses to
# start without it). Do not bake the token into the image.
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
