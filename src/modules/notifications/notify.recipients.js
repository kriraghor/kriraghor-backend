'use strict';

/**
 * M08 recipient adapters (M24 §11.1): people who have no Kriraghor account but whom a module may write
 * to by email, such as a gym's unlinked member whose email the gym typed. A catalogue entry names them
 * as { type, id } in `external(e)`; the module that owns the person registers an adapter that resolves
 * the reference in memory, at routing (locale, reachable?) and again at delivery (the address). No
 * address is ever stored in an event, a notification row or a log.
 *
 *   register(type, { resolve: async (id) → { email, phone, locale } | null })
 *
 * The phone is used only for an SMS the owner of the person paid for (M24 prompt 3b, a billingRef).
 */
const adapters = new Map();

function register(type, adapter) {
  if (typeof adapter?.resolve !== 'function') throw new Error(`Recipient adapter ${type} needs resolve()`);
  adapters.set(type, adapter);
}

/** { email, phone, locale } for a reference, or null (unknown type, gone, or neither address). */
async function resolve(type, id) {
  const a = adapters.get(type);
  if (!a || !id) return null;
  const r = await a.resolve(id);
  if (!r || (!r.email && !r.phone)) return null;
  return { email: r.email ?? null, phone: r.phone ?? null, locale: r.locale === 'bn' ? 'bn' : 'en' };
}

const registered = (type) => adapters.has(type);

module.exports = { register, resolve, registered };
