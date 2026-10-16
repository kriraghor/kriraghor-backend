'use strict';

// M02 KYC rules, 100% branch coverage: NID format and normalisation (FR-06, §6.3), age in Asia/Dhaka,
// file type by magic bytes (FR-03, FR-04 lite), required slots, checks and decisions (FR-09), the
// member role after each KYC event (§6.2) and the badge (§6.4).
const R = require('../../src/modules/kyc/kyc.rules');

const at = (iso) => new Date(iso);

describe('M02 NID number', () => {
  it('accepts 10 and 17 digits as typed, and turns 13-digit legacy numbers into 17 with the birth year', () => {
    expect(R.normaliseNid('1234567890')).toEqual({ value: '1234567890' });
    expect(R.normaliseNid('1990 1234 5678 9012 3')).toEqual({ value: '19901234567890123' });
    expect(R.normaliseNid('269-1234567-890', 1990)).toEqual({ value: '19902691234567890' });
    expect(R.normaliseNid('2691234567890')).toEqual({ error: 'NID_FORMAT_INVALID' }); // 13 digits, no birth year
    expect(R.normaliseNid('12345')).toEqual({ error: 'NID_FORMAT_INVALID' });
    expect(R.normaliseNid('12345678AB')).toEqual({ error: 'NID_FORMAT_INVALID' });
    expect(R.normaliseNid(undefined)).toEqual({ error: 'NID_FORMAT_INVALID' });
  });

  it('masks to the last four digits', () => {
    expect(R.maskNid('19901234567890123')).toBe('•••• 0123');
  });
});

describe('M02 date of birth in Asia/Dhaka', () => {
  const now = at('2026-10-20T19:00:00Z'); // 21 Oct 2026, 01:00 in Dhaka

  it('uses the Dhaka calendar day', () => {
    expect(R.dhakaToday(now)).toBe('2026-10-21');
    expect(R.ageOn('2010-10-21', now)).toBe(16); // birthday today in Dhaka
    expect(R.ageOn('2010-10-22', now)).toBe(15);
    expect(R.ageOn('2010-11-01', now)).toBe(15);
    expect(R.ageOn('2010-09-30', now)).toBe(16);
  });

  it('refuses invalid, future and under-age dates', () => {
    expect(R.dobBlock('2010-10-21', now, 16)).toBeNull();
    expect(R.dobBlock('2010-10-22', now, 16)).toBe('UNDER_MIN_AGE');
    expect(R.dobBlock('2026-10-22', now, 16)).toBe('DOB_IN_FUTURE');
    expect(R.dobBlock('21/10/2010', now, 16)).toBe('DOB_INVALID');
    expect(R.dobBlock('2010-13-45', now, 16)).toBe('DOB_INVALID');
  });
});

describe('M02 files (magic bytes, size, slots)', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  const pdf = Buffer.from('%PDF-1.7\n');

  it('reads the real type from the first bytes', () => {
    expect(R.sniffMime(jpeg)).toBe('image/jpeg');
    expect(R.sniffMime(png)).toBe('image/png');
    expect(R.sniffMime(pdf)).toBe('application/pdf');
    expect(R.sniffMime(Buffer.from('GIF89a'))).toBeNull();
    expect(R.sniffMime(Buffer.from([0xff]))).toBeNull();
    expect(R.sniffMime(Buffer.from([0x89, 0x50]))).toBeNull();
    expect(R.sniffMime(Buffer.from('%P'))).toBeNull();
  });

  it('refuses empty, oversized, unknown and mislabelled files', () => {
    const max = 5 * 1024 * 1024;
    expect(R.fileBlock({ declared: 'image/jpeg', sniffed: 'image/jpeg', size: 100, max })).toBeNull();
    expect(R.fileBlock({ declared: 'image/jpeg', sniffed: 'image/jpeg', size: 0, max })).toBe('FILE_EMPTY');
    expect(R.fileBlock({ declared: 'image/jpeg', sniffed: 'image/jpeg', size: max + 1, max })).toBe('FILE_TOO_LARGE');
    expect(R.fileBlock({ declared: 'image/gif', sniffed: null, size: 10, max })).toBe('FILE_TYPE_NOT_ALLOWED');
    expect(R.fileBlock({ declared: 'image/png', sniffed: null, size: 10, max })).toBe('FILE_TYPE_NOT_ALLOWED');
    expect(R.fileBlock({ declared: 'image/png', sniffed: 'image/jpeg', size: 10, max })).toBe('FILE_TYPE_MISMATCH');
  });

  it('needs exactly one distinct file per required slot', () => {
    const slots = ['front', 'back', 'selfie'];
    expect(R.slotsBlock(slots, { front: 'a', back: 'b', selfie: 'c' })).toBeNull();
    expect(R.slotsBlock(slots, { front: 'a', back: 'b' })).toBe('FILES_INCOMPLETE');
    expect(R.slotsBlock(slots, { front: 'a', back: 'b', selfie: 'c', extra: 'd' })).toBe('FILES_INCOMPLETE');
    expect(R.slotsBlock(slots, { front: 'a', back: 'a', selfie: 'c' })).toBe('FILES_INCOMPLETE');
    expect(R.slotsBlock(slots, undefined)).toBe('FILES_INCOMPLETE');
  });
});

describe('M02 checks and decisions (§6.3, FR-09)', () => {
  it('flags duplicates (blocking) and reused files (warning)', () => {
    const clean = R.checks({ duplicateUsers: 0, reusedFiles: 0 });
    expect(clean.every((c) => c.ok)).toBe(true);
    const bad = R.checks({ duplicateUsers: 1, reusedFiles: 2 });
    expect(bad.find((c) => c.key === 'nid_unique')).toMatchObject({ ok: false, blocks: true, detail: 'On 1 other account(s)' });
    expect(bad.find((c) => c.key === 'file_reused')).toMatchObject({ ok: false, blocks: false });
  });

  const ok = R.checks({ duplicateUsers: 0, reusedFiles: 0 });
  const rubric = { nameMatches: true, readable: true, notExpired: true };

  it('approves only an open document with a full rubric and passing blocking checks', () => {
    expect(R.decisionBlock({ decision: 'approve', status: 'in_review', checks: ok, rubric })).toBeNull();
    expect(R.decisionBlock({ decision: 'approve', status: 'approved', checks: ok, rubric })).toBe('DOC_NOT_IN_REVIEW');
    expect(R.decisionBlock({ decision: 'approve', status: 'in_review', checks: ok, rubric: { ...rubric, readable: false } })).toBe('RUBRIC_INCOMPLETE');
    expect(R.decisionBlock({ decision: 'approve', status: 'in_review', checks: ok })).toBe('RUBRIC_INCOMPLETE');
    expect(R.decisionBlock({ decision: 'approve', status: 'in_review', checks: R.checks({ duplicateUsers: 1, reusedFiles: 0 }), rubric })).toBe('CHECKS_FAILED');
    // A warning never blocks.
    expect(R.decisionBlock({ decision: 'approve', status: 'in_review', checks: R.checks({ duplicateUsers: 0, reusedFiles: 3 }), rubric })).toBeNull();
  });

  it('needs a known reason to request changes or reject', () => {
    expect(R.decisionBlock({ decision: 'reject', status: 'in_review', checks: ok, reasonCode: 'duplicate_nid' })).toBeNull();
    expect(R.decisionBlock({ decision: 'changes_requested', status: 'in_review', checks: ok, reasonCode: 'blurry' })).toBeNull();
    expect(R.decisionBlock({ decision: 'reject', status: 'in_review', checks: ok })).toBe('REASON_REQUIRED');
    expect(R.decisionBlock({ decision: 'reject', status: 'in_review', checks: ok, reasonCode: 'because' })).toBe('REASON_REQUIRED');
    expect(R.DOC_STATUS).toEqual({ approve: 'approved', changes_requested: 'changes_requested', reject: 'rejected' });
  });
});

describe('M02 member role (§6.2) and badge (§6.4)', () => {
  it('moves the member role only from the statuses KYC owns', () => {
    expect(R.memberMove('submitted', 'applied')).toEqual({ role: 'in_review', kyc: 'pending' });
    expect(R.memberMove('submitted', 'rejected')).toEqual({ role: 'in_review', kyc: 'pending' });
    expect(R.memberMove('approved', 'in_review')).toEqual({ role: 'active', kyc: 'verified' });
    expect(R.memberMove('changes_requested', 'in_review')).toEqual({ role: 'changes_requested', kyc: 'unverified' });
    expect(R.memberMove('rejected', 'in_review')).toEqual({ role: 'rejected', kyc: 'rejected' });
    expect(R.memberMove('approved', 'active')).toBeNull();
    expect(R.memberMove('submitted', 'suspended')).toBeNull();
    expect(R.memberMove('rejected', 'rejected')).toBeNull();
  });

  it('shows fully verified, in review or needed', () => {
    expect(R.badge([{ status: 'approved' }, { status: 'approved' }])).toBe('fully_verified');
    expect(R.badge([{ status: 'approved' }, { status: 'in_review' }])).toBe('documents_in_review');
    expect(R.badge([{ status: 'approved' }, { status: 'missing' }])).toBe('verification_needed');
    expect(R.RUBRIC).toEqual(['nameMatches', 'readable', 'notExpired']);
    expect(R.ALLOWED).toHaveLength(3);
    expect(R.MEMBER_AFTER.approved.kyc).toBe('verified');
  });
});
