const path = require('node:path');
/** Authorizes only the paths in a core-reviewed, single-use duplicate plan. */
function createTrashReview({ remove, confirm, isActive }) {
  let plan,
    allowed,
    busy = false;
  return {
    remember(value) {
      if (busy) throw Error('Finish the current file operation first.');
      if (
        !value ||
        typeof value.token !== 'string' ||
        !Array.isArray(value.rows) ||
        !value.rows.length ||
        value.rows.length > 10000 ||
        value.rows.some(
          (row) =>
            typeof row.from !== 'string' ||
            !path.isAbsolute(row.from) ||
            /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(row.from),
        )
      )
        throw Error('Invalid duplicate review.');
      plan = structuredClone(value);
      plan.expires = Date.now() + 300000;
      return value;
    },
    async execute(token, run) {
      if (busy || !plan || plan.token !== token || plan.expires < Date.now() || !isActive())
        throw Error('Review the selected duplicates again.');
      const reviewed = plan;
      plan = null;
      busy = true;
      try {
        if (!(await confirm(structuredClone(reviewed))) || !isActive())
          throw Error('File operation cancelled.');
        allowed = new Set(reviewed.rows.map((row) => row.from));
        return await run();
      } finally {
        allowed = null;
        busy = false;
      }
    },
    async remove(file) {
      if (!allowed?.delete(file)) throw Error('This file was not approved for removal.');
      return remove(file);
    },
  };
}
module.exports = { createTrashReview };
