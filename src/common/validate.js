'use strict';

const { E } = require('./errors');

/**
 * Express middleware factory: validates req[part] against a zod schema and
 * replaces it with the parsed (coerced, stripped) value.
 */
function validate(schema, part = 'body') {
  return (req, _res, next) => {
    const result = schema.safeParse(req[part] ?? {});
    if (!result.success) {
      const errors = result.error.issues.map((i) => ({
        field: i.path.join('.') || part,
        message: i.message,
      }));
      return next(E.validation(errors));
    }
    // Express 5 makes req.query a getter; store parsed values separately for it.
    if (part === 'query') req.validQuery = result.data;
    else req[part] = result.data;
    return next();
  };
}

module.exports = { validate };
