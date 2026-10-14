# syntax=docker/dockerfile:1.7
# One image, four processes (ADR-003). The runtime is distroless Node 24 (Debian 13): its
# entrypoint is node itself and there is no shell, npm or package manager, so the CI Trivy gate
# (fixable HIGH/CRITICAL) has nothing to flag. Kubernetes passes the script as `args`:
#   api       src/server.js       (default)
#   realtime  src/realtime.js
#   worker    src/worker.js
#   migrate   node_modules/sequelize-cli/lib/sequelize db:migrate   (Helm pre-install/pre-upgrade Job; never on boot)
#   one-off   kubectl exec deploy/backend-api -- /nodejs/bin/node scripts/create-master.js ...
# Node runs as PID 1 and handles SIGTERM itself (src/common/lifecycle.js).

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

# Non-root (uid 1000, matching the chart's runAsUser). The root filesystem can be read-only.
USER 1000
EXPOSE 4000 4001 9464
CMD ["src/server.js"]
