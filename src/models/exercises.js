'use strict';

/** M03 reference data (M27-FR-70): the exercise library, EN and BN, seeded from exercises.v1.json; owned by catalog. */
const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../db');
const { uuid7 } = require('../common/uuid7');

const EXERCISE_MUSCLES = ['chest', 'back', 'shoulders', 'arms', 'legs', 'glutes', 'core', 'full_body', 'cardio'];
const EXERCISE_EQUIPMENT = ['none', 'dumbbell', 'barbell', 'machine', 'cable', 'kettlebell', 'band', 'bench', 'other'];
const EXERCISE_LEVELS = ['beginner', 'intermediate', 'advanced'];

class Exercise extends Model {}
Exercise.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() },
    key: { type: DataTypes.STRING(40), allowNull: false },
    nameEn: { type: DataTypes.STRING(80), allowNull: false },
    nameBn: { type: DataTypes.STRING(80), allowNull: false },
    muscle: { type: DataTypes.ENUM(...EXERCISE_MUSCLES), allowNull: false },
    equipment: { type: DataTypes.ENUM(...EXERCISE_EQUIPMENT), allowNull: false },
    level: { type: DataTypes.ENUM(...EXERCISE_LEVELS), allowNull: false },
    stepsEn: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    stepsBn: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    videoUrl: DataTypes.STRING(500),
    sort: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    status: { type: DataTypes.ENUM('active', 'retired'), allowNull: false, defaultValue: 'active' },
  },
  { sequelize, modelName: 'Exercise', tableName: 'exercises' }
);

module.exports = { Exercise };
