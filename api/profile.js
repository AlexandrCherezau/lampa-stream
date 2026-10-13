let profileHandler;

module.exports = async function profile(req, res) {
  if (!profileHandler) {
    profileHandler = import("./_lib/_profile.mjs").then((module) => module.default);
  }
  const handler = await profileHandler;
  return handler(req, res);
};
