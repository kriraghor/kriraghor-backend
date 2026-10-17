'use strict';

/** M17 error catalogue (§9): stable codes for disputes, reports and reviews. Source modules use it too. */
const { AppError } = require('../../common/errors');

const ERRORS = {
  DISPUTE_NOT_ELIGIBLE: [409, 'This cannot be disputed'],
  DISPUTE_WINDOW_CLOSED: [409, 'The time to open a dispute has passed'],
  DISPUTE_ALREADY_OPEN: [409, 'A dispute is already open for this'],
  DISPUTE_LIMIT: [429, 'You already have the most open disputes. Wait for one to finish'],
  DISPUTE_STATE: [409, 'The dispute cannot do that in its current state'],
  DISPUTE_SOURCE_CHANGED: [409, 'The booking changed since the dispute opened; look again'],
  DISPUTE_VERSION: [409, 'Someone else changed this dispute; reload and try again'],
  NOT_YOUR_BOOKING: [403, 'Only the member who paid can dispute this booking'],
  NOT_YOUR_ORDER: [403, 'Only the buyer can dispute this order'],
  NOT_YOUR_JOB: [403, 'Only the manager who paid can dispute this job'],
  NOT_A_PARTY: [404, 'Dispute not found'],
  CONFLICT_OF_INTEREST: [403, 'You are part of this dispute and cannot decide it'],
  CLAIMED_BY_OTHER: [409, 'Another staff member is working on this case'],
  CLAIM_REQUIRED: [403, 'Claim this case before deciding'],
  REFUND_PERMISSION_REQUIRED: [403, 'You need the small refunds permission to decide a refund'],
  ESCALATION_REQUIRED: [403, 'This refund is above your limit; escalate it to a master'],
  MASTER_REQUIRED: [403, 'Only a master admin can do this'],
  OUTCOME_NOT_ALLOWED: [422, 'That outcome does not apply to this case'],
  REFUND_INVALID: [422, 'Choose a refund between nothing and what is held'],
  EVIDENCE_LIMIT: [409, 'You have added the most files allowed'],
  FILE_TYPE: [415, 'Upload a JPEG, PNG, WebP or PDF'],
  FILE_TOO_LARGE: [413, 'That file is too large'],
  CORRECTION_REQUIRED: [422, 'Enter the corrected results'],
  REPORT_SELF: [422, 'You cannot report yourself or your own listing'],
  REPORT_DUPLICATE: [409, 'You have already reported this; our team is looking at it'],
  REPORT_SUBJECT_UNKNOWN: [404, 'We could not find what you are reporting'],
  RESOLUTION_NOT_ALLOWED: [422, 'That action does not apply to this kind of report'],
  NOTHING_OPEN: [409, 'There are no open reports about this'],
  NOT_PLAYED: [409, 'You can rate a ground after you have played there'],
  REVIEW_WINDOW_CLOSED: [409, 'The time to rate this booking has passed'],
  REVIEW_EXISTS: [409, 'You have already rated this booking'],
  REVIEW_EDIT_CLOSED: [409, 'This review can no longer be changed'],
  REVIEW_HIDDEN: [409, 'This review was hidden by our team'],
  REVIEW_STATE: [409, 'The review cannot do that in its current state'],
  NOT_OWNER: [403, 'Only the ground owner can reply'],
};

const fail = (code, meta) => new AppError(ERRORS[code][0], code, ERRORS[code][1], meta ? { meta } : undefined);

module.exports = { ERRORS, fail };
