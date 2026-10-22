'use strict';

/** Round B3 controllers: thin wrappers over business-members.service. */
const svc = require('./business-members.service');

module.exports = {
  workplaces: async (req, res) => res.json(await svc.workplaces(req.user)),
  listTeam: async (req, res) => res.json(await svc.listTeam(req.user, req.validQuery)),
  add: async (req, res) => res.status(201).json(await svc.add(req.user, req.body, req)),
  updatePermissions: async (req, res) => res.json(await svc.updatePermissions(req.user, req.params.id, req.body, req)),
  remove: async (req, res) => res.json(await svc.remove(req.user, req.params.id, req)),
};
