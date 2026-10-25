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

// §6.3 age_ok with kyc.min_age_years 18 (product owner, 25 Oct 2026), on fixed clocks in Asia/Dhaka.
describe('M02 minimum age 18 (§6.3 age_ok, 25 Oct 2026)', () => {
  const noon = at('2026-10-25T06:00:00Z'); // 25 Oct 2026, 12:00 in Dhaka

  it('accepts the 18th birthday and refuses 17 years and 364 days', () => {
    expect(R.dobBlock('2008-10-25', noon, 18)).toBeNull();
    expect(R.ageOn('2008-10-25', noon)).toBe(18);
    expect(R.dobBlock('2008-10-26', noon, 18)).toBe('UNDER_MIN_AGE');
    expect(R.ageOn('2008-10-26', noon)).toBe(17);
    expect(R.dobBlock('1990-05-14', noon, 18)).toBeNull();
  });

  it('turns 18 at midnight in Dhaka, which is 18:00 UTC the day before', () => {
    const lastMinute = at('2026-10-24T17:59:59.999Z'); // 24 Oct, 23:59:59 in Dhaka
    const midnight = at('2026-10-24T18:00:00.000Z'); // 25 Oct, 00:00 in Dhaka
    expect(R.dobBlock('2008-10-25', lastMinute, 18)).toBe('UNDER_MIN_AGE');
    expect(R.dobBlock('2008-10-25', midnight, 18)).toBeNull();
  });

  it('a 29 February birthday turns 18 on 1 March in a common year', () => {
    expect(R.dobBlock('2008-02-29', at('2026-02-28T06:00:00Z'), 18)).toBe('UNDER_MIN_AGE');
    expect(R.dobBlock('2008-02-29', at('2026-03-01T06:00:00Z'), 18)).toBeNull();
    expect(R.dobBlock('2008-02-29', at('2026-02-28T18:00:00Z'), 18)).toBeNull(); // 1 Mar 00:00 in Dhaka
  });

  it('prefilters birth years with one year of slack', () => {
    expect(R.underAgeFromYear(noon, 18)).toBe(2007);
    expect(R.underAgeFromYear(at('2026-12-31T18:00:00Z'), 18)).toBe(2008); // already 2027 in Dhaka
  });
});

// M02-FR-05 (25 Oct 2026): explicit consent to the current version.
describe('M02 consent', () => {
  it.each([
    [undefined, 'CONSENT_REQUIRED'],
    [null, 'CONSENT_REQUIRED'],
    [true, 'CONSENT_REQUIRED'],
    [false, 'CONSENT_REQUIRED'],
    ['yes', 'CONSENT_REQUIRED'],
    [1, 'CONSENT_REQUIRED'],
    [{}, 'CONSENT_REQUIRED'],
    [[], 'CONSENT_REQUIRED'],
    [{ accepted: false, version: 1 }, 'CONSENT_REQUIRED'],
    [{ accepted: 'true', version: 1 }, 'CONSENT_REQUIRED'],
    [{ accepted: true }, 'CONSENT_VERSION_STALE'],
    [{ accepted: true, version: 0 }, 'CONSENT_VERSION_STALE'],
    [{ accepted: true, version: '1' }, 'CONSENT_VERSION_STALE'],
    [{ accepted: true, version: 2 }, 'CONSENT_VERSION_STALE'],
    [{ accepted: true, version: 1 }, null],
  ])('%p → %p', (given, code) => {
    expect(R.consentBlock(given, 1)).toBe(code);
  });

  it('fills placeholders, with Bangla digits for Bangla text, and leaves unknown ones', () => {
    expect(R.fillText('deleted {retentionDays} days after; {minAge} and over', { retentionDays: 90, minAge: 18 })).toBe('deleted 90 days after; 18 and over');
    expect(R.fillText('{retentionDays} দিন পর; {minAge} বছর', { retentionDays: 90, minAge: 18 }, { bn: true })).toBe('৯০ দিন পর; ১৮ বছর');
    expect(R.fillText('{other} {minAge} {gone}', { minAge: 18, gone: null })).toBe('{other} 18 {gone}');
    expect(R.toBnDigits('2026-10-25')).toBe('২০২৬-১০-২৫');
  });

  it('the shipped consent: one version, an NID and a business text in EN and BN', () => {
    const consent = require('../../src/modules/kyc/consent');
    const seed = require('../../src/db/seed/reference/kyc-requirements.v1.json');
    expect(consent.current()).toEqual({ version: seed.consent.version, draft: true });
    expect(consent.check({ accepted: true, version: seed.consent.version })).toBeNull();
    expect(consent.check(true)).toBe('CONSENT_REQUIRED');
    // The k3d e2e specs find the checkbox by this text (kriraghor-infrastructure).
    expect(seed.consent.nid.en).toMatch(/^I agree that Kriraghor uses these documents/);
    for (const kind of ['nid', 'business']) {
      for (const locale of ['en', 'bn']) expect(seed.consent[kind][locale]).toContain('{retentionDays}');
    }
    expect(seed.consent.nid.en).toContain('{minAge}');
    expect(seed.consent.nid.bn).toContain('{minAge}');
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

describe('M02 checks (§6.3) and the M05 adapter (FR-08)', () => {
  it('flags duplicates (blocking) and reused files (warning)', () => {
    const clean = R.checks({ verifiedHolders: 0, pendingHolders: 0, reusedFiles: 0 });
    expect(clean.every((c) => c.ok)).toBe(true);
    const bad = R.checks({ verifiedHolders: 1, pendingHolders: 2, reusedFiles: 2 });
    expect(bad.find((c) => c.key === 'nid_unique')).toMatchObject({ ok: false, blocks: true, detail: 'Verified on 1 other account(s)' });
    expect(bad.find((c) => c.key === 'nid_pending_elsewhere')).toMatchObject({ ok: false, blocks: true, detail: 'Waiting for review on 2 other account(s)' });
    expect(R.LOCKED_CHECKS).toEqual(['nid_unique']);
    expect(bad.find((c) => c.key === 'file_reused')).toMatchObject({ ok: false, blocks: false });
  });

  // Decisions are M05's (moderation.rules); M02 maps its checks onto M05 rows.
  it('maps checks to M05 severities and results, and gives each user one stable subject per document type', () => {
    const { toModeration, subjectIdFor } = require('../../src/modules/kyc/kyc.moderation');
    expect(toModeration(R.checks({ verifiedHolders: 1, pendingHolders: 0, reusedFiles: 2 })).map((c) => [c.key, c.severity, c.result])).toEqual([
      ['nid_format', 'hard', 'pass'],
      ['age_ok', 'hard', 'pass'],
      ['nid_unique', 'hard', 'fail'],
      ['nid_pending_elsewhere', 'hard', 'pass'],
      ['file_type', 'soft', 'pass'],
      ['file_reused', 'soft', 'warn'],
    ]);
    const u = '0190f3a2-0000-7000-8000-000000000001';
    expect(subjectIdFor(u, 'nid')).toBe(subjectIdFor(u, 'nid', ''));
    expect(subjectIdFor(u, 'nid')).not.toBe(subjectIdFor(u, 'trade_license'));
    expect(subjectIdFor(u, 'nid')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
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
    expect(R.memberMove('approved', 'rejected')).toEqual({ role: 'active', kyc: 'verified' });
    expect(R.memberMove('submitted', 'suspended')).toBeNull();
    expect(R.memberMove('rejected', 'rejected')).toBeNull();
  });

  it('shows fully verified, in review or needed', () => {
    expect(R.badge([{ status: 'approved' }, { status: 'approved' }])).toBe('fully_verified');
    expect(R.badge([{ status: 'approved' }, { status: 'in_review' }])).toBe('documents_in_review');
    expect(R.badge([{ status: 'approved' }, { status: 'missing' }])).toBe('verification_needed');
    expect(R.ALLOWED).toHaveLength(3);
    expect(R.MEMBER_AFTER.approved.kyc).toBe('verified');
  });
});

describe('M02 business documents per role (M12)', () => {
  it('uses the role asked for, or the only applied role that needs the type', () => {
    const both = ['ground_owner', 'shop_owner'];
    expect(R.businessRoleFor({ asked: 'shop_owner', requirementRoles: both, appliedRoles: both })).toEqual({ role: 'shop_owner' });
    expect(R.businessRoleFor({ asked: 'shop_owner', requirementRoles: both, appliedRoles: ['ground_owner'] })).toEqual({ error: 'ROLE_NOT_APPLIED' });
    expect(R.businessRoleFor({ asked: 'shop_owner', requirementRoles: ['ground_owner'], appliedRoles: both })).toEqual({ error: 'DOC_TYPE_NOT_REQUIRED' });
    expect(R.businessRoleFor({ requirementRoles: both, appliedRoles: ['shop_owner'] })).toEqual({ role: 'shop_owner' });
    expect(R.businessRoleFor({ requirementRoles: both, appliedRoles: both })).toEqual({ error: 'ROLE_AMBIGUOUS' });
    expect(R.businessRoleFor({ requirementRoles: both, appliedRoles: [] })).toEqual({ error: 'ROLE_NOT_APPLIED' });
    expect(R.businessRoleFor({ requirementRoles: [], appliedRoles: both })).toEqual({ error: 'DOC_TYPE_NOT_REQUIRED' });
  });
});
