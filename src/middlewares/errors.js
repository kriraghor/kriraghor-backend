'use strict';

const crypto = require('crypto');
const { UniqueConstraintError, ValidationError: SequelizeValidationError } = require('sequelize');
const { AppError } = require('../common/errors');
const logger = require('../common/logger');

function requestId(req, res, next) {
  const incoming = req.get('x-request-id');
  req.id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  res.set('X-Request-Id', req.id);
  next();
}

function notFound(req, _res, next) {
  next(new AppError(404, 'ROUTE_NOT_FOUND', 'Not found', { detail: `${req.method} ${req.path} does not exist` }));
}

/** Renders every error as RFC 7807 application/problem+json. */
function errorHandler(err, req, res, _next) {
  let e = err;
  if (err instanceof UniqueConstraintError) {
    e = new AppError(409, 'CONFLICT', 'This already exists', { errors: err.errors?.map((x) => ({ field: x.path, message: 'Already in use' })) });
  } else if (err instanceof SequelizeValidationError) {
    e = new AppError(422, 'VALIDATION_FAILED', 'Some fields are invalid', { errors: err.errors.map((x) => ({ field: x.path, message: x.message })) });
  } else if (err?.type === 'entity.parse.failed') {
    e = new AppError(400, 'INVALID_JSON', 'The request body is not valid JSON');
  } else if (err?.type === 'entity.too.large') {
    e = new AppError(413, 'PAYLOAD_TOO_LARGE', 'The request body is too large');
  }

  if (!(e instanceof AppError)) {
    logger.error({ err, reqId: req.id, path: req.path }, 'unhandled error');
    e = new AppError(500, 'INTERNAL', 'Something went wrong on our side', { detail: 'Try again. If it keeps happening, contact support.' });
  }

  if (e.status === 429 && e.meta?.retryAfter) res.set('Retry-After', String(e.meta.retryAfter));
  res
    .status(e.status)
    .type('application/problem+json')
    .json({
      type: `https://docs.kriraghor.com/errors/${e.code.toLowerCase().replace(/_/g, '-')}`,
      title: e.title,
      status: e.status,
      code: e.code,
      ...(e.detail ? { detail: e.detail } : {}),
      ...(e.errors ? { errors: e.errors } : {}),
      ...(e.meta ? e.meta : {}),
      instance: req.originalUrl,
      requestId: req.id,
    });
}

module.exports = { requestId, notFound, errorHandler };
