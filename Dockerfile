# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:24.16.0-bookworm-slim
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs24-debian13:nonroot@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e

# ---- deps: production node_modules only ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force

# ---- runtime ----
FROM ${RUNTIME_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=4000 \
    REALTIME_PORT=4001 \
    OPS_PORT=9464
WORKDIR /app
COPY --from=deps --chown=1000:1000 /app/node_modules ./node_modules
COPY --chown=1000:1000 package.json package-lock.json .sequelizerc openapi.json ./
COPY --chown=1000:1000 src ./src
COPY --chown=1000:1000 scripts ./scripts

# Non-root user
USER 1000
EXPOSE 4000 4001 9464

CMD ["src/server.js"]