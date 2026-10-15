'use strict';

/**
 * Realtime unread counts (M08-FR-04). Any process (api, worker) emits to the Socket.IO room
 * user:{id} through the Redis emitter; the realtime pods (Redis adapter, same key) forward it to
 * the user's sockets. Best effort: the bell also re-reads its count when it (re)connects.
 */
const config = require('../../config');
const logger = require('../../common/logger');
const { createRedis } = require('../../common/redis');

let emitter;
const emitted = []; // tests only

function getEmitter() {
  if (!emitter) {
    const { Emitter } = require('@socket.io/redis-emitter');
    emitter = new Emitter(createRedis('notify-emitter'), { key: `${config.redis.prefix}:socket.io` });
  }
  return emitter;
}

/** Emit `name` with `data` to one user's room. Never throws. */
function toUser(userId, name, data) {
  if (config.isTest) {
    emitted.push({ userId, name, data });
    return;
  }
  try {
    getEmitter().to(`user:${userId}`).emit(name, data);
  } catch (err) {
    logger.warn({ err: err.message, userId, name }, 'realtime emit failed');
  }
}

module.exports = { toUser, emitted: () => emitted.slice(), clearEmitted: () => emitted.splice(0, emitted.length) };
