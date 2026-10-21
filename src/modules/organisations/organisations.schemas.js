'use strict';

/** M14 lite request and response schemas (zod → validation and OpenAPI). */
const { z } = require('zod');

const id = z.uuid();
const dateTime = z.iso.datetime({ offset: true });
const nullable = (t) => t.nullable();
const STATUSES = ['draft', 'pending_review', 'changes_requested', 'verified', 'rejected', 'suspended'];

const orgParam = z.object({ orgId: id });
const idParam = z.object({ id });
const memberParams = z.object({ orgId: id, memberId: id });
const fields = {
  name: z.string().trim().min(3).max(120),
  areaId: id.nullable().optional(),
  about: z.string().trim().max(1000).nullable().optional(),
  contactEmail: z.email().max(160).nullable().optional(),
};
// kind: sports (M14 physical tournaments) or esports (the M22 console, only while
// esports.external_organisers_enabled is on); set once, never edited.
const KINDS = ['esports', 'sports'];
const createBody = z.object({ ...fields, kind: z.enum(KINDS).default('sports') });
const updateBody = z
  .object(fields)
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');
const memberBody = z.object({ phone: z.string().trim().min(10).max(20).meta({ description: 'The phone of an existing Kriraghor member' }), role: z.enum(['admin', 'staff']) });
const adminQuery = z.object({ status: z.enum(STATUSES).optional(), kind: z.enum(KINDS).optional(), q: z.string().trim().max(60).optional() });
const reasonBody = z.object({ reason: z.string().trim().min(5).max(300) });

const Organisation = z
  .object({
    id,
    slug: z.string(),
    kind: z.enum(KINDS),
    name: z.string(),
    areaId: nullable(id),
    about: nullable(z.string()),
    contactEmail: nullable(z.string()),
    status: z.enum(STATUSES),
    ownerId: id,
    reviewReason: nullable(z.object({ code: z.string(), text: nullable(z.string()) })),
    verifiedAt: nullable(dateTime),
    role: nullable(z.enum(['owner', 'admin', 'staff'])),
    createdAt: dateTime,
  })
  .meta({ id: 'Organisation' });
const OrganisationList = z.object({ items: z.array(Organisation) }).meta({ id: 'OrganisationList' });
const Member = z.object({ id, userId: id, name: nullable(z.string()), role: z.enum(['owner', 'admin', 'staff']), addedAt: dateTime });
const MemberList = z.object({ items: z.array(Member) }).meta({ id: 'OrganisationMemberList' });
const StaffOrganisation = Organisation.extend({ members: z.array(Member) }).meta({ id: 'StaffOrganisation' });
const MemberResult = z.object({ id, userId: id.optional(), role: z.string().optional(), status: z.string().optional() }).meta({ id: 'OrganisationMemberResult' });

module.exports = { orgParam, idParam, memberParams, createBody, updateBody, memberBody, adminQuery, reasonBody, Organisation, OrganisationList, MemberList, StaffOrganisation, MemberResult };
