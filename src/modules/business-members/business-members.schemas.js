'use strict';

/**
 * Round B3 request and response schemas (zod → validation and OpenAPI). Permission keys are checked
 * against the business type's allow-list in the service (business-members.rules), not here, so the
 * error names exactly what is not allowed (PERMISSIONS_INVALID).
 */
const { z } = require('zod');
const { normalizePhone } = require('../../common/identifiers');
const rules = require('./business-members.rules');

const id = z.uuid();
const businessType = z.enum(rules.TYPES).meta({ description: 'venue (a ground), gym or shop' });
const permissionKey = z.string().min(3).max(40);
const phone = z.string().transform((v, ctx) => {
  const p = normalizePhone(v);
  if (!p) ctx.addIssue({ code: 'custom', message: 'Enter a Bangladesh mobile number' });
  return p ?? v;
});

// ---------------- requests
const idParam = z.object({ id });
const teamQuery = z.object({
  businessType: businessType.optional(),
  businessId: id.optional(),
  status: z.enum(['active', 'removed', 'all']).default('active'),
});
const addBody = z.object({
  businessType,
  businessId: id,
  phone: phone.meta({ description: 'The staff member’s verified phone number (they must already have a Kriraghor account)' }),
  permissions: z.array(permissionKey).max(20).optional().meta({ description: 'Leave out for the defaults of the business type' }),
});
const permissionsBody = z.object({ permissions: z.array(permissionKey).max(20) });

// ---------------- shared by the staff-capable desks' response schemas
/**
 * A response key that business staff never receive (rules.STAFF_HIDDEN_KEYS, stripped by forStaff):
 * optional in the shared schema, always present for the owner. Other modules use it through the
 * index's `schemas` facade so the OpenAPI document says the same thing everywhere.
 */
const STAFF_HIDDEN_NOTE = 'Absent for business staff (Round B3); always present for the owner';
const staffHidden = (schema) => schema.optional().meta({ description: STAFF_HIDDEN_NOTE });

// ---------------- responses
const BusinessRef = z.object({ businessType, id, name: z.string().nullable(), status: z.string().nullable() });
const TeamMember = z
  .object({
    id,
    businessType,
    businessId: id,
    business: BusinessRef.nullable(),
    member: z.object({ id, displayName: z.string().nullable(), phoneLast4: z.string().nullable() }),
    permissions: z.array(z.string()),
    status: z.enum(['active', 'removed']),
    addedAt: z.string(),
    removedAt: z.string().nullable(),
  })
  .meta({ id: 'BusinessTeamMember' });
const PermissionCatalogue = z.record(z.string(), z.array(z.object({ key: z.string(), default: z.boolean(), needs: z.string().nullable() })));
const TeamList = z.object({ items: z.array(TeamMember), businesses: z.array(BusinessRef), permissionCatalogue: PermissionCatalogue, maxMembers: z.number().int() });
const TeamChange = z.object({ member: TeamMember, unchanged: z.boolean().optional() });
const Workplace = z
  .object({
    id,
    businessType,
    businessId: id,
    business: BusinessRef,
    owner: z.object({ id, displayName: z.string().nullable() }),
    permissions: z.array(z.string()),
    since: z.string(),
  })
  .meta({ id: 'BusinessWorkplace' });
const WorkplaceList = z.object({ items: z.array(Workplace) });

module.exports = { idParam, teamQuery, addBody, permissionsBody, TeamMember, TeamList, TeamChange, Workplace, WorkplaceList, STAFF_HIDDEN_NOTE, staffHidden };
