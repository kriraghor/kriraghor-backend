'use strict';

/**
 * The business-members module's public interface (ADR-007 §3): other modules use only this file;
 * everything else in business-members is internal (tests/unit/boundaries.test.js). Each facade lists
 * exactly what other modules call. Functions delegate lazily, so requiring the index never changes
 * load order and cannot create a require cycle at load time.
 *
 *   access      actFor and its helpers (Round B3): who acts for which venue, gym or shop
 *   businesses  the business port: venues, gyms and shops register their adapter at boot
 *   members     workplaces for the principal (M01), staff recipients (M08), the staff to-do (M19)
 *   consumers   the owner-changed consumers (registry.registerAll)
 *   schemas     staffHidden(): marks a response key business staff never receive (OpenAPI)
 */
const lazy = (file, names, values = []) => {
  const out = Object.fromEntries(names.map((n) => [n, (...args) => require(file)[n](...args)]));
  for (const v of values) Object.defineProperty(out, v, { enumerable: true, get: () => require(file)[v] });
  return Object.freeze(out);
};

module.exports = {
  access: lazy('./business-members.rules', ['actFor', 'can', 'businessesWith', 'defaultWorkplace', 'forStaff', 'ownerLive', 'workplaceAt'], ['STAFF_HIDDEN_KEYS', 'OWNER_ONLY']),
  businesses: lazy('./businesses.port', ['register']),
  members: lazy('./business-members.service', ['workplacesOf', 'staffRecipients', 'pendingActions', 'businessName']),
  consumers: lazy('./business-members.consumers', ['registerBusinessMemberConsumers']),
  schemas: lazy('./business-members.schemas', ['staffHidden']),
};
