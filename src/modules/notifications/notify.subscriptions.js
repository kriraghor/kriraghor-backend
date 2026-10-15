'use strict';

/**
 * M08 router (§2.2): one M04 consumer per (event, catalogue code), named notify.<CODE>. Each runs
 * under the M04 inbox, so a re-delivered event never notifies twice; the dedupe key is the second guard.
 */
const { onEvent } = require('../events/events.consumers');
const { CATALOGUE } = require('./notify.catalogue');
const { route } = require('./notify.service');

function registerNotifications() {
  for (const entry of CATALOGUE) {
    for (const event of entry.events) {
      onEvent(event, `notify.${entry.code}`, (e, { transaction }) => route(entry, e, { transaction }));
    }
  }
}

module.exports = { registerNotifications };
