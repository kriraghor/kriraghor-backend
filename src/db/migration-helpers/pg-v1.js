'use strict';

/**
 * Column and constraint helpers for the PostgreSQL migrations (ADR-005), version 1. Migrations depend
 * on these exact definitions, so this file is FROZEN: never change what a helper produces. If a
 * helper must work differently, add pg-v2.js and use it in new migrations only.
 *
 * Conventions:
 *  - ids are native UUID; times TIMESTAMP(3) WITH TIME ZONE (ms, like JS dates) in UTC; JSON is
 *    JSONB; money BIGINT poisha;
 *  - "enum" columns are VARCHAR with a named CHECK constraint (ck_<table>_<column>), not Postgres
 *    ENUM types: no orphan types after dropTable, and a value list changes by swapping the CHECK;
 *  - append-only tables get the shared trigger function kg_forbid_change().
 */
module.exports = function helpers(Sequelize) {
  const { DataTypes } = Sequelize;

  // Millisecond precision, like JavaScript dates (Sequelize's DATE(3) would give microseconds on Postgres).
  const TS = 'TIMESTAMP(3) WITH TIME ZONE';
  const now = { type: TS, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
  const uuid = { type: DataTypes.UUID, allowNull: false };
  const quote = (id) => `"${id.replace(/"/g, '""')}"`;
  const list = (values) => values.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(', ');

  /** A VARCHAR long enough for every value; pair it with enumCheck(). */
  const enumCol = (values, extra = {}) => ({ type: DataTypes.STRING(Math.max(...values.map((v) => v.length))), allowNull: false, ...extra });

  /** ck_<table>_<column> CHECK (column IN (...)); NULL passes, so nullable enum columns work. */
  async function enumCheck(queryInterface, table, column, values, name = `ck_${table}_${column}`) {
    await queryInterface.sequelize.query(`ALTER TABLE ${quote(table)} ADD CONSTRAINT ${quote(name)} CHECK (${quote(column)} IN (${list(values)}))`);
  }

  /** Swap an enum CHECK for a new value list (adding or removing values). */
  async function replaceEnumCheck(queryInterface, table, column, values, name = `ck_${table}_${column}`) {
    await queryInterface.sequelize.query(`ALTER TABLE ${quote(table)} DROP CONSTRAINT IF EXISTS ${quote(name)}`);
    await enumCheck(queryInterface, table, column, values, name);
  }

  /** The shared append-only trigger function (idempotent). */
  async function ensureForbidFunction(queryInterface) {
    await queryInterface.sequelize.query(
      'CREATE OR REPLACE FUNCTION kg_forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$ ' +
        "BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'P0001'; END $$"
    );
  }

  /** BEFORE UPDATE OR DELETE trigger that refuses changes (corrections are new rows). */
  async function appendOnly(queryInterface, table) {
    await ensureForbidFunction(queryInterface);
    await queryInterface.sequelize.query(
      `CREATE TRIGGER ${quote(`trg_${table}_append_only`)} BEFORE UPDATE OR DELETE ON ${quote(table)} FOR EACH ROW EXECUTE FUNCTION kg_forbid_change()`
    );
  }

  async function dropAppendOnly(queryInterface, table) {
    await queryInterface.sequelize.query(`DROP TRIGGER IF EXISTS ${quote(`trg_${table}_append_only`)} ON ${quote(table)}`);
  }

  /** An "enum" column type: VARCHAR tagged with its values; createTable/addColumn add the CHECK. */
  function ENUM(...values) {
    const type = DataTypes.STRING(Math.max(...values.map((v) => v.length)));
    type.kgEnum = values;
    return type;
  }

  // Read the tags before calling Sequelize: it replaces each attribute's type with a dialect type in place.
  const enumColumns = (attributes) => Object.entries(attributes).filter(([, def]) => def && def.type && def.type.kgEnum).map(([column, def]) => [column, def.type.kgEnum]);

  /** queryInterface.createTable plus a CHECK for every ENUM(...) column. */
  async function createTable(queryInterface, table, attributes) {
    const enums = enumColumns(attributes);
    await queryInterface.createTable(table, attributes);
    for (const [column, values] of enums) await enumCheck(queryInterface, table, column, values);
  }

  /** queryInterface.addColumn plus the CHECK when the column is an ENUM(...). */
  async function addColumn(queryInterface, table, column, def) {
    const values = def.type && def.type.kgEnum;
    await queryInterface.addColumn(table, column, def);
    if (values) await enumCheck(queryInterface, table, column, values);
  }

  return { TS, now, uuid, enumCol, enumCheck, replaceEnumCheck, ensureForbidFunction, appendOnly, dropAppendOnly, quote, ENUM, createTable, addColumn };
};
