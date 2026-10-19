'use strict';

/**
 * M22 branding (FR-11, FR-12): logo, primary and accent colours (WCAG AA checked), taglines, and the
 * subdomain {sub}.esports.kriraghor.com. Changes are audited and go live at once once the contrast
 * check passes. The public lookup serves the esports app's branded pages (verified organisations only).
 */
const crypto = require('crypto');
const { UniqueConstraintError } = require('sequelize');
const { E } = require('../../common/errors');
const storage = require('../../common/storage');
const { sniffMime } = require('../../common/filetype');
const { sequelize, Organisation, OrganisationBranding } = require('../../models');
const audit = require('../audit').audit;
const tournaments = require('../esports').tournaments;
const rules = require('./saas.rules');
const c = require('./saas.common');

const { fail } = c;
const LOGO_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_LOGO = 2 * 1024 * 1024;

function view(b, org) {
  return {
    organisationId: org.id,
    name: org.name,
    slug: org.slug,
    subdomain: b?.subdomain ?? null,
    logoUrl: b?.logoKey ? storage.publicUrl(b.logoKey) : null,
    primaryHex: b?.primaryHex ?? '#0b7a4b',
    accentHex: b?.accentHex ?? '#f2a33a',
    taglineEn: b?.taglineEn ?? null,
    taglineBn: b?.taglineBn ?? null,
    status: b?.status ?? 'draft',
    version: b?.version ?? 0,
  };
}

async function rowFor(orgId, transaction) {
  const [b] = await OrganisationBranding.findOrCreate({ where: { organisationId: orgId }, defaults: { organisationId: orgId }, transaction });
  return OrganisationBranding.findByPk(b.organisationId, { transaction, lock: transaction.LOCK.UPDATE });
}

async function get(org) {
  return view(await OrganisationBranding.findByPk(org.id), org.row ?? org);
}

/** PUT /org/:orgId/branding (org admin): colours and taglines. */
async function update(principal, org, body, req) {
  const block = rules.brandingBlock({ primaryHex: body.primaryHex, accentHex: body.accentHex });
  if (block) throw fail(block);
  return sequelize.transaction(async (transaction) => {
    const b = await rowFor(org.id, transaction);
    await b.update({ primaryHex: body.primaryHex, accentHex: body.accentHex, taglineEn: body.taglineEn ?? null, taglineBn: body.taglineBn ?? null, status: 'live', version: b.version + 1, updatedBy: principal.id }, { transaction });
    await audit.record({ action: 'organisation_branding.updated', actor: principal, entityType: 'organisation', entityId: org.id, after: { primaryHex: body.primaryHex, accentHex: body.accentHex, version: b.version }, req }, { transaction });
    await c.publish(transaction, 'organisation_branding.published', 'organisation', org.id, { organisationId: org.id, version: b.version, subdomain: b.subdomain ?? null }, principal);
    return view(b, org.row);
  });
}

/** PUT /org/:orgId/branding/subdomain (org admin): claim or change it (UNIQUE: the first wins). */
async function claimSubdomain(principal, org, { subdomain }, req) {
  const sub = String(subdomain ?? '').trim().toLowerCase();
  const block = rules.subdomainBlock(sub, c.config().reserved);
  if (block) throw fail(block);
  return sequelize.transaction(async (transaction) => {
    const b = await rowFor(org.id, transaction);
    try {
      await sequelize.transaction({ transaction }, (sp) => b.update({ subdomain: sub, version: b.version + 1, updatedBy: principal.id }, { transaction: sp }));
    } catch (err) {
      if (err instanceof UniqueConstraintError) throw fail('SUBDOMAIN_TAKEN');
      throw err;
    }
    await audit.record({ action: 'organisation_branding.subdomain_claimed', actor: principal, entityType: 'organisation', entityId: org.id, after: { subdomain: sub }, req }, { transaction });
    return view(b, org.row);
  });
}

/** POST /org/:orgId/branding/logo (raw image, org admin): public bucket, a new key each time. */
async function uploadLogo(principal, org, { contentType, body }, req) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
  const declared = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  if (!buf.length) throw fail('FILE_EMPTY');
  if (buf.length > MAX_LOGO) throw fail('FILE_TOO_LARGE');
  if (!LOGO_TYPES[declared]) throw fail('FILE_TYPE_NOT_ALLOWED');
  if (sniffMime(buf) !== declared) throw fail('FILE_TYPE_MISMATCH');
  const key = `organisations/${org.id}/logo-${crypto.randomBytes(6).toString('hex')}.${LOGO_TYPES[declared]}`;
  await storage.putPublic(key, buf, declared);
  return sequelize.transaction(async (transaction) => {
    const b = await rowFor(org.id, transaction);
    await b.update({ logoKey: key, version: b.version + 1, updatedBy: principal.id }, { transaction });
    await audit.record({ action: 'organisation_branding.logo_uploaded', actor: principal, entityType: 'organisation', entityId: org.id, meta: { sizeBytes: buf.length }, req }, { transaction });
    return view(b, org.row);
  });
}

/** GET /esports/organisers/:subdomain (public): a verified organisation's branding and its public tournaments. */
async function bySubdomain(subdomain) {
  const b = await OrganisationBranding.findOne({ where: { subdomain: String(subdomain).toLowerCase() } });
  const org = b ? await Organisation.findByPk(b.organisationId) : null;
  if (!b || !org || org.status !== 'verified' || b.status === 'suspended') throw E.notFound('Organiser');
  const list = await tournaments.list({ organisationId: org.id, limit: 50 });
  return { organiser: view(b, org), tournaments: list.items };
}

module.exports = { view, get, update, claimSubdomain, uploadLogo, bySubdomain };
