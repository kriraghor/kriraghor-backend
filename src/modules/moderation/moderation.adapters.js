'use strict';

/**
 * M05 subject adapters (§6.6). Each subject module registers its kind when it loads:
 *
 *   register({
 *     kind,                      // submissions.kind (the DB CHECK lists the kinds built so far)
 *     permission,                // staff flag that may list, claim and decide it (masters always may)
 *     checks(submission, { transaction }) → [{ key, severity: 'hard'|'soft', result, detail? }]
 *                                // re-run on claim (FR-05); read-only
 *     ownerWithdraw?: boolean,   // owners may withdraw through /me/submissions (default true)
 *     lockedChecks?: string[],   // hard check keys a master may not override (default none)
 *   })
 *
 * The subject module applies decisions in its consumers of submission.approved / .changes_requested /
 * .rejected and acknowledges with submission.applied (FR-13).
 */
const adapters = new Map();

function register(adapter) {
  if (!adapter?.kind || !adapter.permission || typeof adapter.checks !== 'function') throw new Error('A moderation adapter needs kind, permission and checks()');
  adapters.set(adapter.kind, { ownerWithdraw: true, lockedChecks: [], ...adapter });
}

function get(kind) {
  const a = adapters.get(kind);
  if (!a) throw new Error(`No moderation adapter for ${kind}`);
  return a;
}

const kinds = () => [...adapters.keys()];

/** Kinds a staff member may see: by permission flag; masters see all (§3, FR-17). */
const permittedKinds = (principal) => kinds().filter((k) => principal.isMaster || principal.permissions?.has?.(adapters.get(k).permission));

module.exports = { register, get, kinds, permittedKinds };
