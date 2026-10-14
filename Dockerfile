# syntax=docker/dockerfile:1.7
# One image, four commands (ADR-003):
#   api       node src/server.js       (default)
#   realtime  node src/realtime.js
#   worker    node src/worker.js
#   migrate   node node_modules/.bin/sequelize db:migrate   (Helm pre-install/pre-upgrade Job; never on boot)
# Node runs as PID 1 and handles SIGTERM itself (src/common/lifecycle.js); no process spawns children,
# so no init process is needed. The migrate Job calls sequelize-cli directly rather than through npm.

ARG NODE_IMAGE=node:24.16.0-bookworm-slim

# ---- deps: production node_modules only ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force

# ---- runtime ----
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=4000 \
    REALTIME_PORT=4001 \
    OPS_PORT=9464 \
    NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json .sequelizerc openapi.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts

# Non-root (uid 1000). The root filesystem can be mounted read-only: the app writes nothing to disk.
USER node
EXPOSE 4000 4001 9464
CMD ["node", "src/server.js"]
