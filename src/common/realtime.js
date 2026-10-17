'use strict';

/**
 * Server-to-client realtime (M08 unread counts, M21 tournaments). Any process (api, worker) emits to
 * Socket.IO rooms through the Redis emitter; the realtime pods (Redis adapter, same key) forward to
 * the sockets in the room. Best effort: clients re-read state when they (re)connect.
 *   user:{id}                 private: only that user's sockets (secrets such as room credentials go here only)
 *   esports_tournament:{id}   public: slots, status, standings, streams
 *   esports_match:{id}        public: match status, posted results
 *   ground:{id}               public: "availability changed" (M10), the grid re-reads
 */
const config = require('../config');
const logger = require('./logger');
const { createRedis } = require('./redis');

let emitter;
const emitted = []; // tests only

function getEmitter() {
  if (!emitter) {
    const { Emitter } = require('@socket.io/redis-emitter');
    emitter = new Emitter(createRedis('realtime-emitter'), { key: `${config.redis.prefix}:socket.io` });
  }
  return emitter;
}

/** Emit `name` with `data` to a room. Never throws. */
function toRoom(room, name, data) {
  if (config.isTest) {
    emitted.push(room.startsWith('user:') ? { userId: room.slice(5), name, data } : { room, name, data });
    return;
  }
  try {
    getEmitter().to(room).emit(name, data);
  } catch (err) {
    logger.warn({ err: err.message, room, name }, 'realtime emit failed');
  }
}

const toUser = (userId, name, data) => toRoom(`user:${userId}`, name, data);

/** Public rooms a client may subscribe to (the socket server checks this list). */
const PUBLIC_ROOM = /^(esports_(tournament|match)|ground):[0-9a-f-]{36}$/;

module.exports = { toRoom, toUser, PUBLIC_ROOM, emitted: () => emitted.slice(), clearEmitted: () => emitted.splice(0, emitted.length) };
