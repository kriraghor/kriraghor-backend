'use strict';

/**
 * M04-FR-16 retry delay: 2^attempt seconds, capped (events.backoff_cap_sec, 15 min by default).
 * `attempt` counts completed attempts (1 after the first failure). Pure, 100% branch coverage.
 */
function backoffMs(attempt, capSec) {
  const n = Math.max(1, Math.floor(attempt));
  const capMs = Math.max(1, capSec) * 1000;
  // 2^n overflows past ~1000; anything over the cap is the cap.
  return n >= 30 ? capMs : Math.min(2 ** n * 1000, capMs);
}

module.exports = { backoffMs };
