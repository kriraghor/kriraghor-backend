'use strict';

const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const config = require('../config');
const logger = require('../common/logger');
const { compile } = require('../common/origins');
const { socketConnections } = require('../common/metrics');
const { AUDIENCES, verifyAccessToken } = require('../modules/auth/access.service');

const allowedOrigin = compile([...config.corsOrigins, ...config.adminOrigins]);

/** Room names (00-platform/07). Room credentials are only ever emitted to user rooms. */
const rooms = {
  user: (id) => `user:${id}`,
  staff: 'staff',
};

/**
 * Socket.IO server (ADR-003 backend-realtime).
 * Handshake: auth.token (access token) and auth.audience ("api" by default, "admin" from the
 * admin portal). The token goes through the same checks as HTTP requests (access.service).
 * The socket is disconnected when the token expires; the client reconnects with a fresh one.
 */
function createRealtimeServer(httpServer, { adapter } = {}) {
  const io = new Server(httpServer, {
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    cors: {
      origin: (origin, done) => done(null, !origin || allowedOrigin(origin)),
      credentials: true,
    },
    serveClient: false,
  });
  if (adapter) io.adapter(adapter);

  io.use(async (socket, next) => {
    try {
      const { token, audience = AUDIENCES.API } = socket.handshake.auth ?? {};
      if (!Object.values(AUDIENCES).includes(audience)) throw new Error('bad audience');
      const { principal, auth } = await verifyAccessToken(token, audience);
      socket.data.userId = principal.id;
      socket.data.audience = audience;
      socket.data.sessionId = auth.sessionId;
      socket.data.exp = jwt.decode(token).exp * 1000;
      return next();
    } catch (err) {
      const e = new Error(err.code ?? 'AUTH_REQUIRED');
      e.data = { code: err.code ?? 'AUTH_REQUIRED' };
      return next(e);
    }
  });

  io.on('connection', (socket) => {
    socketConnections.inc();
    socket.join(rooms.user(socket.data.userId));
    if (socket.data.audience === AUDIENCES.ADMIN) socket.join(rooms.staff);
    socket.emit('ready', { userId: socket.data.userId, rooms: [...socket.rooms].filter((r) => r !== socket.id) });

    const ttl = Math.max(0, socket.data.exp - Date.now());
    const expiry = setTimeout(() => {
      socket.emit('auth.expired');
      socket.disconnect(true);
    }, ttl);

    socket.on('disconnect', () => {
      clearTimeout(expiry);
      socketConnections.dec();
    });
  });

  logger.debug('realtime server created');
  return io;
}

module.exports = { createRealtimeServer, rooms };
