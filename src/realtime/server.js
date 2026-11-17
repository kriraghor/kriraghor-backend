'use strict';

const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const config = require('../config');
const logger = require('../common/logger');
const { compile } = require('../common/origins');
const { socketConnections } = require('../common/metrics');
const { AUDIENCES, verifyAccessToken } = require('../modules/auth/access.service');
const { PUBLIC_ROOM } = require('../common/realtime');

const MAX_PUBLIC_ROOMS = 10;

const allowedOrigin = compile([...config.corsOrigins, ...config.adminOrigins]);

/** Room names (00-platform/07). Room credentials are only ever emitted to user rooms. */
const rooms = {
  user: (id) => `user:${id}`,
  staff: 'staff',
  // M24 §21: devices in desk mode at a gym (the live check-in feed).
  gymDesk: (gymId) => `gym_desk:${gymId}`,
};

/**
 * Socket.IO server (ADR-003 backend-realtime).
 * Handshake: auth.token (access token) and auth.audience ("api" by default, "admin" from the
 * admin portal). The token goes through the same checks as HTTP requests (access.service).
 * The socket is disconnected when the token expires; the client reconnects with a fresh one.
 * Without a token the socket is a guest: no user room, public rooms only (M21 tournament pages).
 * Clients may join public rooms (esports_tournament:{id}, esports_match:{id}) with `subscribe`;
 * nothing else can be joined from the client.
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
      if (!token && audience === AUDIENCES.API) {
        socket.data.userId = null;
        socket.data.audience = audience;
        socket.data.exp = null;
        return next();
      }
      const { principal, auth } = await verifyAccessToken(token, audience);
      socket.data.userId = principal.id;
      socket.data.audience = audience;
      socket.data.sessionId = auth.sessionId;
      socket.data.exp = jwt.decode(token).exp * 1000;
      // M24 §21 (ADR-010): a device in gym desk mode gets its gym's desk feed only, never the person's own room.
      socket.data.deskGymId = audience === AUDIENCES.API ? await require('../modules/gym-manage').desk.deskGymOf(auth.familyId) : null;
      return next();
    } catch (err) {
      const e = new Error(err.code ?? 'AUTH_REQUIRED');
      e.data = { code: err.code ?? 'AUTH_REQUIRED' };
      return next(e);
    }
  });

  io.on('connection', (socket) => {
    socketConnections.inc();
    if (socket.data.deskGymId) socket.join(rooms.gymDesk(socket.data.deskGymId));
    else if (socket.data.userId) socket.join(rooms.user(socket.data.userId));
    if (socket.data.audience === AUDIENCES.ADMIN) socket.join(rooms.staff);
    socket.emit('ready', { userId: socket.data.userId, rooms: [...socket.rooms].filter((r) => r !== socket.id) });

    const expiry = socket.data.exp
      ? setTimeout(() => {
          socket.emit('auth.expired');
          socket.disconnect(true);
        }, Math.max(0, socket.data.exp - Date.now()))
      : null;

    // Public rooms only, and a few at a time; the ack says whether it worked.
    socket.on('subscribe', (room, ack) => {
      const joined = [...socket.rooms].filter((r) => PUBLIC_ROOM.test(r)).length;
      const ok = typeof room === 'string' && PUBLIC_ROOM.test(room) && joined < MAX_PUBLIC_ROOMS;
      if (ok) socket.join(room);
      if (typeof ack === 'function') ack({ ok });
    });
    socket.on('unsubscribe', (room) => {
      if (typeof room === 'string' && PUBLIC_ROOM.test(room)) socket.leave(room);
    });

    socket.on('disconnect', () => {
      if (expiry) clearTimeout(expiry);
      socketConnections.dec();
    });
  });

  logger.debug('realtime server created');
  return io;
}

module.exports = { createRealtimeServer, rooms };
