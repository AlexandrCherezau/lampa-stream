// Keep the Vercel function entrypoint CommonJS. Vercel currently loads this
// route through its CommonJS runtime; statically re-exporting the ESM handler
// makes its loader emit require("./_lib/_profile.mjs"), which Node rejects.
// Native dynamic import works from CommonJS and the promise is reused by warm
// invocations so the ESM module is initialized only once per function.
let profileHandler;

module.exports = async function profile(req, res) {
  if (!profileHandler) {
    profileHandler = import("./_lib/_profile.mjs").then((module) => module.default);
  }
  const handler = await profileHandler;
  return handler(req, res);
};
