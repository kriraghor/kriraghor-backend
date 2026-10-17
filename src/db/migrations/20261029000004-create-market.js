'use strict';

/**
 * M12 Market catalogue, step 1 (§7; v3): shops, products, product_variants, product_photos,
 * inventory_movements, saved_items. Used listings, offers and offer rules come in step 2 with M13.
 *
 *  - shops and products keep the owner's working copy in their columns and the approved public
 *    version in live_snapshot (the M09 pattern, FR-02): an edit of a live row runs beside it
 *    (edit_status) and the public keeps the snapshot until the edit is approved.
 *  - products.public_*: search columns copied from the public version whenever it changes, so browse
 *    filters and sorts in SQL and never reads an unreviewed working copy.
 *  - product_variants: on_hand and held are a cache of inventory_movements (FR-10, FR-11);
 *    available is generated. Supplements carry expiry_date and batch_no per variant (v3, decision
 *    17 Oct 2026); sale_blocked hides a variant that is expired or too close to expiry.
 *  - inventory_movements: append-only ledger; the partial unique index makes M13's hold, release,
 *    commit and restock idempotent on (type, reference) (FR-12).
 *  - product_photos: polymorphic owner (product now, used_listing in step 2); never deleted.
 *  - saved_items: polymorphic (product now, used_listing in step 2); unsaving sets removed_at.
 */
const STATUSES = ['draft', 'pending_review', 'changes_requested', 'live', 'paused', 'rejected', 'withdrawn', 'suspended', 'removed'];
const EDIT_STATUSES = ['draft', 'pending_review', 'changes_requested', 'rejected'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    const { DataTypes } = Sequelize;
    const now = { type: h.TS, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const at = { type: h.TS, allowNull: true };
    const uuid = { type: DataTypes.UUID, allowNull: false };
    const optUuid = { type: DataTypes.UUID, allowNull: true };
    const fk = (table) => ({ ...uuid, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const audit = () => ({ created_by: optUuid, updated_by: optUuid, created_at: now, updated_at: now });
    const review = () => ({
      status: { type: h.ENUM(...STATUSES), allowNull: false, defaultValue: 'draft' },
      edit_status: { type: h.ENUM(...EDIT_STATUSES), allowNull: true },
      live_version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      live_snapshot: { type: DataTypes.JSONB, allowNull: true },
      current_submission_id: optUuid,
      review_reason_code: { type: DataTypes.STRING(40), allowNull: true },
      review_reason_text: { type: DataTypes.STRING(500), allowNull: true },
      first_live_at: at,
      status_changed_at: at,
    });
    const q = (sql) => queryInterface.sequelize.query(sql);

    await h.createTable(queryInterface, 'shops', {
      id: { ...uuid, primaryKey: true },
      owner_id: fk('users'),
      shop_type: { type: h.ENUM('sports_gear', 'supplements', 'gym_gear'), allowNull: false },
      name: { type: DataTypes.STRING(80), allowNull: false },
      slug: { type: DataTypes.STRING(96), allowNull: false },
      area_id: fk('areas'),
      address_line: { type: DataTypes.STRING(200), allowNull: false },
      lat: { type: DataTypes.DECIMAL(9, 6), allowNull: true },
      lng: { type: DataTypes.DECIMAL(9, 6), allowNull: true },
      about: { type: DataTypes.TEXT, allowNull: true },
      ...review(),
      // Stock rules (§4 Inventory desk; FR-14, FR-15, FR-06). Explicit save, audited.
      low_stock_threshold: { type: DataTypes.SMALLINT, allowNull: false },
      auto_hide_out_of_stock: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      mto_days_default: { type: DataTypes.SMALLINT, allowNull: false },
      rating_avg: { type: DataTypes.DECIMAL(3, 2), allowNull: true },
      rating_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      ...audit(),
    });
    // FR-01: one shop per owner in v1.
    await queryInterface.addIndex('shops', ['owner_id'], { unique: true, name: 'uq_shops_owner' });
    await queryInterface.addIndex('shops', ['slug'], { unique: true, name: 'uq_shops_slug' });
    await queryInterface.addIndex('shops', ['status'], { name: 'ix_shops_status' });
    await q('CREATE INDEX ix_shops_name_trgm ON shops USING GIN (name gin_trgm_ops)');
    await q("ALTER TABLE shops ADD CONSTRAINT chk_shops_snapshot CHECK (live_snapshot IS NOT NULL OR status NOT IN ('live', 'paused', 'suspended'))");
    await q('ALTER TABLE shops ADD CONSTRAINT chk_shops_rules CHECK (low_stock_threshold BETWEEN 0 AND 1000 AND mto_days_default BETWEEN 1 AND 30)');

    await h.createTable(queryInterface, 'products', {
      id: { ...uuid, primaryKey: true },
      shop_id: fk('shops'),
      item_type_id: fk('item_types'),
      title: { type: DataTypes.STRING(120), allowNull: false },
      slug: { type: DataTypes.STRING(140), allowNull: false },
      brand: { type: DataTypes.STRING(60), allowNull: true },
      description: { type: DataTypes.TEXT, allowNull: true },
      specs: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      base_price_poisha: { type: DataTypes.BIGINT, allowNull: false },
      is_mto: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      mto_days: { type: DataTypes.SMALLINT, allowNull: true },
      max_qty_per_order: { type: DataTypes.SMALLINT, allowNull: false },
      // v3 supplements: importer or BSTI registration (checked against the category in the service).
      importer: { type: DataTypes.STRING(120), allowNull: true },
      bsti_reg_no: { type: DataTypes.STRING(60), allowNull: true },
      ...review(),
      visibility: { type: h.ENUM('visible', 'hidden_oos'), allowNull: false, defaultValue: 'visible' },
      public_title: { type: DataTypes.STRING(120), allowNull: true },
      public_item_type_id: optUuid,
      public_price_from_poisha: { type: DataTypes.BIGINT, allowNull: true },
      public_price_to_poisha: { type: DataTypes.BIGINT, allowNull: true },
      views: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      ...audit(),
    });
    await queryInterface.addIndex('products', ['slug'], { unique: true, name: 'uq_products_slug' });
    await queryInterface.addIndex('products', ['shop_id', 'status'], { name: 'ix_products_shop_status' });
    await queryInterface.addIndex('products', ['status', 'visibility', 'public_item_type_id', 'public_price_from_poisha'], { name: 'ix_products_browse' });
    await q('CREATE INDEX ix_products_specs ON products USING GIN (specs)');
    await q('CREATE INDEX ix_products_public_title_trgm ON products USING GIN (public_title gin_trgm_ops)');
    await q("ALTER TABLE products ADD CONSTRAINT chk_products_snapshot CHECK (live_snapshot IS NOT NULL OR status NOT IN ('live', 'paused', 'suspended'))");
    await q('ALTER TABLE products ADD CONSTRAINT chk_products_price CHECK (base_price_poisha > 0)');
    await q('ALTER TABLE products ADD CONSTRAINT chk_products_mto CHECK ((is_mto AND mto_days BETWEEN 1 AND 30) OR (NOT is_mto AND mto_days IS NULL))');
    await q('ALTER TABLE products ADD CONSTRAINT chk_products_qty CHECK (max_qty_per_order BETWEEN 1 AND 100)');

    await h.createTable(queryInterface, 'product_variants', {
      id: { ...uuid, primaryKey: true },
      product_id: fk('products'),
      shop_id: fk('shops'),
      sku: { type: DataTypes.STRING(40), allowNull: true },
      attributes: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      price_override_poisha: { type: DataTypes.BIGINT, allowNull: true },
      on_hand: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      held: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      low_alerted_at: at,
      expiry_date: { type: DataTypes.DATEONLY, allowNull: true },
      batch_no: { type: DataTypes.STRING(40), allowNull: true },
      sale_blocked: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      status: { type: h.ENUM('active', 'retired'), allowNull: false, defaultValue: 'active' },
      retired_at: at,
      sort: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
      ...audit(),
    });
    await q('ALTER TABLE product_variants ADD COLUMN available INTEGER GENERATED ALWAYS AS (on_hand - held) STORED');
    await q('ALTER TABLE product_variants ADD CONSTRAINT chk_product_variants_stock CHECK (on_hand >= 0 AND held >= 0 AND held <= on_hand)');
    await q('ALTER TABLE product_variants ADD CONSTRAINT chk_product_variants_price CHECK (price_override_poisha IS NULL OR price_override_poisha > 0)');
    await queryInterface.addIndex('product_variants', ['product_id', 'status'], { name: 'ix_product_variants_product' });
    // One active variant per attribute set (and batch, for supplements); SKUs unique within a shop.
    await q("CREATE UNIQUE INDEX uq_product_variants_attributes ON product_variants (product_id, attributes, COALESCE(batch_no, '')) WHERE status = 'active'");
    await q("CREATE UNIQUE INDEX uq_product_variants_sku ON product_variants (shop_id, lower(sku)) WHERE sku IS NOT NULL AND status = 'active'");
    await q("CREATE INDEX ix_product_variants_expiry ON product_variants (expiry_date) WHERE expiry_date IS NOT NULL AND status = 'active'");

    await h.createTable(queryInterface, 'product_photos', {
      id: { ...uuid, primaryKey: true },
      owner_type: { type: h.ENUM('product', 'used_listing'), allowNull: false },
      owner_id: uuid,
      storage_key: { type: DataTypes.STRING(255), allowNull: false },
      mime: { type: h.ENUM('image/jpeg', 'image/png', 'image/webp'), allowNull: false },
      size_bytes: { type: DataTypes.INTEGER, allowNull: false },
      sha256: { type: DataTypes.CHAR(64), allowNull: false },
      sort: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
      status: { type: h.ENUM('active', 'removed'), allowNull: false, defaultValue: 'active' },
      version_added: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      removed_at: at,
      ...audit(),
    });
    await queryInterface.addIndex('product_photos', ['owner_type', 'owner_id', 'status', 'sort'], { name: 'ix_product_photos_owner' });
    await queryInterface.addIndex('product_photos', ['sha256'], { name: 'ix_product_photos_sha256' });

    await h.createTable(queryInterface, 'inventory_movements', {
      id: { ...uuid, primaryKey: true },
      variant_id: fk('product_variants'),
      type: { type: h.ENUM('receive', 'adjust', 'hold', 'release', 'commit', 'return_restock', 'correction'), allowNull: false },
      delta_on_hand: { type: DataTypes.INTEGER, allowNull: false },
      delta_held: { type: DataTypes.INTEGER, allowNull: false },
      on_hand_after: { type: DataTypes.INTEGER, allowNull: false },
      held_after: { type: DataTypes.INTEGER, allowNull: false },
      reason_code: { type: h.ENUM('opening', 'received', 'count_correction', 'damaged', 'lost', 'other', 'order', 'return'), allowNull: true },
      reason_text: { type: DataTypes.STRING(200), allowNull: true },
      ref_type: { type: h.ENUM('sub_order_item', 'return', 'manual'), allowNull: false },
      ref_id: optUuid,
      actor_id: optUuid,
      created_at: now,
    });
    await queryInterface.addIndex('inventory_movements', ['variant_id', 'created_at'], { name: 'ix_inventory_movements_variant' });
    await q("CREATE UNIQUE INDEX uq_inventory_movements_ref ON inventory_movements (type, ref_type, ref_id, variant_id) WHERE ref_type <> 'manual'");
    await q("ALTER TABLE inventory_movements ADD CONSTRAINT chk_inventory_movements_ref CHECK ((ref_type = 'manual') = (ref_id IS NULL))");
    await h.appendOnly(queryInterface, 'inventory_movements');

    await h.createTable(queryInterface, 'saved_items', {
      id: { ...uuid, primaryKey: true },
      user_id: fk('users'),
      item_type: { type: h.ENUM('product', 'used_listing'), allowNull: false },
      item_id: uuid,
      price_at_save_poisha: { type: DataTypes.BIGINT, allowNull: false },
      last_alerted_at: at,
      // Unsaving sets removed_at (records are never deleted); saving again starts a new row.
      removed_at: at,
      created_at: now,
    });
    await q('CREATE UNIQUE INDEX uq_saved_items ON saved_items (user_id, item_type, item_id) WHERE removed_at IS NULL');
    await q('CREATE INDEX ix_saved_items_item ON saved_items (item_type, item_id) WHERE removed_at IS NULL');
  },

  async down(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    await h.dropAppendOnly(queryInterface, 'inventory_movements');
    for (const t of ['saved_items', 'inventory_movements', 'product_photos', 'product_variants', 'products', 'shops']) await queryInterface.dropTable(t);
  },
};
