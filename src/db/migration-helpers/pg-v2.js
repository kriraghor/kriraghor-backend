'use strict';

/**
 * Idempotent migration helpers for the PostgreSQL migrations (ADR-005), version 2.
 *
 * pg-v1 is FROZEN and still used by the earliest migrations. v2 exists because Sequelize's
 * queryInterface.createTable emits CREATE TABLE IF NOT EXISTS, so re-running a migration against a
 * database that already holds its tables silently skips the CREATE and then fails on the statements
 * that follow ("constraint ck_... already exists"). That happens in practice when a deploy crashes
 * part way through, when migrations are renamed or reordered, or when a database was built from a
 * later schema than the migration files describe: the schema is ahead of SequelizeMeta.
 *
 * Rules for every helper here:
 *  - objects that already exist are left alone, or replaced with the exact same definition
 *    (CHECK constraints, enum CHECKs), so a re-run converges instead of aborting;
 *  - missing objects are created;
 *  - a table that exists but lacks columns gets the missing ones added; a NOT NULL column without a
 *    default cannot be added to a table that already holds rows, so that is reported on stdout
 *    instead of failing the deploy.
 * New migrations should use these helpers. Never change what an existing migration produced.
 */
module.exports = function helpers(Sequelize) {
  const { QueryTypes } = Sequelize;
  const v1 = require('./pg-v1')(Sequelize);
  const quote = v1.quote;

  const warn = (message) => console.warn(`[migration] ${message}`);
  const select = (queryInterface, sql, replacements) =>
    queryInterface.sequelize.query(sql, { type: QueryTypes.SELECT, replacements });

  /** Does the table exist in the public schema? */
  async function tableExists(queryInterface, table) {
    const rows = await select(
      queryInterface,
      "SELECT 1 AS present FROM information_schema.tables WHERE table_schema = 'public' AND table_name = :t",
      { t: table }
    );
    return rows.length > 0;
  }

  async function constraintExists(queryInterface, table, name) {
    const rows = await select(
      queryInterface,
      'SELECT 1 AS present FROM pg_constraint WHERE conname = :n AND conrelid = to_regclass(:t)',
      { n: name, t: `public.${table}` }
    );
    return rows.length > 0;
  }

  async function indexExists(queryInterface, name) {
    const rows = await select(
      queryInterface,
      "SELECT 1 AS present FROM pg_indexes WHERE schemaname = 'public' AND indexname = :n",
      { n: name }
    );
    return rows.length > 0;
  }

  async function triggerExists(queryInterface, table, name) {
    const rows = await select(
      queryInterface,
      'SELECT 1 AS present FROM pg_trigger WHERE tgname = :n AND tgrelid = to_regclass(:t) AND NOT tgisinternal',
      { n: name, t: `public.${table}` }
    );
    return rows.length > 0;
  }

  /** addColumn only when the column is missing; keeps the ENUM(...) CHECK in step. */
  async function ensureColumn(queryInterface, table, column, def) {
    if (!(await tableExists(queryInterface, table))) return;
    const described = await queryInterface.describeTable(table);
    if (described[column]) return;
    const values = def && def.type && def.type.kgEnum;
    await queryInterface.addColumn(table, column, def);
    // replace, not add: a column left by an older schema version may carry a narrower CHECK.
    if (values) await v1.replaceEnumCheck(queryInterface, table, column, values);
  }

  /**
   * createTable (CREATE TABLE IF NOT EXISTS), then repair a table left behind by an older schema
   * version and re-apply the CHECK of every ENUM(...) column with the values from this migration.
   */
  async function ensureTable(queryInterface, table, attributes) {
    // Read the tags before calling Sequelize: it replaces each attribute's type in place.
    const enums = Object.entries(attributes)
      .filter(([, def]) => def && def.type && def.type.kgEnum)
      .map(([column, def]) => [column, def.type.kgEnum]);
    const existed = await tableExists(queryInterface, table);

    await queryInterface.createTable(table, attributes);

    if (existed) {
      const described = await queryInterface.describeTable(table);
      for (const [column, def] of Object.entries(attributes)) {
        if (described[column] || !def || !def.type) continue;
        if (def.allowNull === false && def.defaultValue === undefined) {
          warn(`${table}.${column} is missing and cannot be added safely (NOT NULL without a default)`);
          continue;
        }
        await queryInterface.addColumn(table, column, def);
      }
    }

    for (const [column, values] of enums) await v1.replaceEnumCheck(queryInterface, table, column, values);
  }

  /** addIndex only when no index of that name exists (the definition is ours, from the same file). */
  async function ensureIndex(queryInterface, table, attributes, options = {}) {
    if (await indexExists(queryInterface, options.name)) return;
    await queryInterface.addIndex(table, attributes, options);
  }

  /** For hand-written CREATE INDEX statements, which have no IF NOT EXISTS in some forms. */
  async function ensureIndexSql(queryInterface, name, sql) {
    if (await indexExists(queryInterface, name)) return;
    await queryInterface.sequelize.query(sql);
  }

  /** addConstraint (UNIQUE) only when no constraint of that name exists. */
  async function ensureConstraint(queryInterface, table, definition) {
    if (await constraintExists(queryInterface, table, definition.name)) return;
    await queryInterface.addConstraint(table, definition);
  }

  /** For hand-written ALTER TABLE ... ADD CONSTRAINT sql; skipped when the name is already taken. */
  async function ensureConstraintSql(queryInterface, table, name, sql) {
    if (await constraintExists(queryInterface, table, name)) return;
    await queryInterface.sequelize.query(sql);
  }

  /** CHECK constraints are replaced, so a re-run refreshes the value list of an enum CHECK. */
  async function ensureCheck(queryInterface, table, name, sql) {
    await queryInterface.sequelize.query(`ALTER TABLE ${quote(table)} DROP CONSTRAINT IF EXISTS ${quote(name)}`);
    await queryInterface.sequelize.query(`ALTER TABLE ${quote(table)} ADD CONSTRAINT ${quote(name)} ${sql}`);
  }

  /** CREATE TRIGGER / CREATE CONSTRAINT TRIGGER only when the trigger does not exist yet. */
  async function ensureTrigger(queryInterface, table, name, sql) {
    if (await triggerExists(queryInterface, table, name)) return;
    await queryInterface.sequelize.query(sql);
  }

  /** The append-only guard, created only once per table (kg_forbid_change itself is idempotent). */
  async function ensureAppendOnly(queryInterface, table) {
    await v1.ensureForbidFunction(queryInterface);
    await ensureTrigger(
      queryInterface,
      table,
      `trg_${table}_append_only`,
      `CREATE TRIGGER ${quote(`trg_${table}_append_only`)} BEFORE UPDATE OR DELETE ON ${quote(table)} ` +
        'FOR EACH ROW EXECUTE FUNCTION kg_forbid_change()'
    );
  }

  return {
    // Unchanged conventions from pg-v1.
    TS: v1.TS,
    now: v1.now,
    uuid: v1.uuid,
    quote,
    ENUM: v1.ENUM,
    enumCol: v1.enumCol,
    enumCheck: v1.enumCheck,
    replaceEnumCheck: v1.replaceEnumCheck,
    ensureForbidFunction: v1.ensureForbidFunction,
    dropAppendOnly: v1.dropAppendOnly,
    // Re-runnable replacements for the pg-v1 DDL helpers.
    tableExists,
    ensureColumn,
    ensureTable,
    ensureIndex,
    ensureIndexSql,
    ensureConstraint,
    ensureConstraintSql,
    ensureCheck,
    ensureTrigger,
    ensureAppendOnly,
  };
};