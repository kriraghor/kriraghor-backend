'use strict';

/**
 * Application error rendered as RFC 7807 problem+json by the error handler.
 * `code` is a stable, machine-readable identifier the frontend can switch on.
 */
class AppError extends Error {
  constructor(status, code, title, { detail, errors, meta } = {}) {
    super(detail || title);
    this.status = status;
    this.code = code;
    this.title = title;
    this.detail = detail;
    this.errors = errors;
    this.meta = meta;
  }
}

const E = {
  validation: (errors) => new AppError(422, 'VALIDATION_FAILED', 'Some fields are invalid', { errors }),
  badRequest: (code, title, detail) => new AppError(400, code, title, { detail }),
  unauthorized: (code = 'AUTH_REQUIRED', title = 'Sign in to continue', detail) =>
    new AppError(401, code, title, { detail }),
  forbidden: (code, title, detail, meta) => new AppError(403, code, title, { detail, meta }),
  notFound: (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`),
  conflict: (code, title, detail) => new AppError(409, code, title, { detail }),
  tooMany: (code, title, detail, meta) => new AppError(429, code, title, { detail, meta }),
};

module.exports = { AppError, E };
