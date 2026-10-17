'use strict';

/**
 * Realtime unread counts (M08-FR-04) through the shared emitter (common/realtime): user:{id} only.
 * Best effort: the bell also re-reads its count when it (re)connects.
 */
const { toUser, emitted, clearEmitted } = require('../../common/realtime');

module.exports = { toUser, emitted, clearEmitted };
