'use strict';

/**
 * M02 KYC lite (§7). NID verification: requirements as data, versioned documents with encrypted fields,
 * and the files behind them in the private bucket.
 *
 *  - document_requirements: what each role needs (seeded from kyc-requirements.v1.json); derived items
 *    (phone) have no document type;
 *  - verification_documents: one row per submitted version; partial unique indexes keep one current
 *    version and one open (in_review) version per user, type and subject (FR-11);
 *  - document_files: uploads, attached to a document on submit; images are purged after the retention
 *    period while the hash, type and size stay (FR-17).
 * doc_type is a CHECK list (`nid` for now); business types widen it when their modules arrive.
 */
const DOC_TYPES = ['nid'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    const { DataTypes } = Sequelize;
    const TS = 'TIMESTAMP(3) WITH TIME ZONE';
    const now = { type: TS, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const uuid = { type: DataTypes.UUID, allowNull: false };
    const optUuid = { type: DataTypes.UUID, allowNull: true };
    const user = { references: { model: 'users', key: 'id' }, onDelete: 'RESTRICT' };

    await h.createTable(queryInterface, 'document_requirements', {
      id: { ...uuid, primaryKey: true },
      role: { type: DataTypes.STRING(32), allowNull: false },
      doc_type: { type: DataTypes.STRING(30), allowNull: true },
      derived_key: { type: DataTypes.STRING(30), allowNull: true },
      scope: { type: h.ENUM('user', 'role', 'hire_role'), allowNull: false, defaultValue: 'user' },
      required: { type: h.ENUM('always', 'conditional', 'optional'), allowNull: false, defaultValue: 'always' },
      file_slots: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      field_schema: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      label_en: { type: DataTypes.STRING(120), allowNull: false },
      label_bn: { type: DataTypes.STRING(120), allowNull: false },
      why_en: { type: DataTypes.STRING(300), allowNull: true },
      why_bn: { type: DataTypes.STRING(300), allowNull: true },
      sort: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.sequelize.query(
      'ALTER TABLE document_requirements ADD CONSTRAINT ck_document_requirements_kind CHECK ((doc_type IS NULL) <> (derived_key IS NULL))'
    );
    await queryInterface.sequelize.query(
      "CREATE UNIQUE INDEX uq_document_requirements_active ON document_requirements (role, COALESCE(doc_type, derived_key)) WHERE is_active"
    );

    await h.createTable(queryInterface, 'verification_documents', {
      id: { ...uuid, primaryKey: true },
      user_id: { ...uuid, ...user },
      doc_type: { type: h.ENUM(...DOC_TYPES), allowNull: false },
      subject_key: { type: DataTypes.STRING(64), allowNull: false, defaultValue: '' },
      version: { type: DataTypes.INTEGER, allowNull: false },
      status: { type: h.ENUM('in_review', 'changes_requested', 'approved', 'rejected', 'superseded', 'withdrawn'), allowNull: false },
      is_current: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      // number, DOB and legal name, AES-256-GCM (common/crypto); never returned unmasked except the audited reveal.
      fields_enc: { type: DataTypes.TEXT, allowNull: false },
      fields_public: { type: DataTypes.JSONB, allowNull: false },
      nid_hash: { type: DataTypes.CHAR(64), allowNull: true },
      checks: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      decided_by: optUuid,
      decided_at: { type: TS, allowNull: true },
      reason_code: { type: DataTypes.STRING(40), allowNull: true },
      reason_text: { type: DataTypes.STRING(500), allowNull: true },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('verification_documents', ['user_id', 'doc_type', 'subject_key'], {
      unique: true,
      name: 'uq_verification_documents_current',
      where: { is_current: true },
    });
    await queryInterface.addIndex('verification_documents', ['user_id', 'doc_type', 'subject_key'], {
      unique: true,
      name: 'uq_verification_documents_one_open',
      where: { status: 'in_review' },
    });
    await queryInterface.addIndex('verification_documents', ['user_id', 'doc_type', 'subject_key', 'version'], { unique: true, name: 'uq_verification_documents_version' });
    await queryInterface.addIndex('verification_documents', ['status', 'created_at'], { name: 'ix_verification_documents_status' });
    await queryInterface.addIndex('verification_documents', ['nid_hash'], { name: 'ix_verification_documents_nid_hash' });

    await h.createTable(queryInterface, 'document_files', {
      id: { ...uuid, primaryKey: true },
      user_id: { ...uuid, ...user },
      document_id: { ...optUuid, references: { model: 'verification_documents', key: 'id' }, onDelete: 'RESTRICT' },
      slot: { type: DataTypes.STRING(20), allowNull: false },
      storage_key: { type: DataTypes.STRING(200), allowNull: false },
      mime: { type: h.ENUM('image/jpeg', 'image/png', 'application/pdf'), allowNull: false },
      size_bytes: { type: DataTypes.INTEGER, allowNull: false },
      sha256: { type: DataTypes.CHAR(64), allowNull: false },
      // type_checked: magic bytes and size checked (lite); clean / infected once a virus scanner runs.
      scan_status: { type: h.ENUM('type_checked', 'clean', 'infected'), allowNull: false, defaultValue: 'type_checked' },
      purged_at: { type: TS, allowNull: true },
      created_at: now,
    });
    await queryInterface.sequelize.query('ALTER TABLE document_files ADD CONSTRAINT ck_document_files_size CHECK (size_bytes > 0 AND size_bytes <= 20971520)');
    await queryInterface.addIndex('document_files', ['document_id'], { name: 'ix_document_files_document' });
    await queryInterface.addIndex('document_files', ['sha256'], { name: 'ix_document_files_sha256' });
    await queryInterface.addIndex('document_files', ['user_id', 'created_at'], { name: 'ix_document_files_user' });
  },

  async down(queryInterface) {
    for (const table of ['document_files', 'verification_documents', 'document_requirements']) await queryInterface.dropTable(table);
  },
};
