/*
 * The Sinewave version. This is the ONE place it lives: the player, the dashboard and the
 * server all read it from here, so they always agree.
 *
 * Every pull request bumps it (see CONTRIBUTING.md):
 *   - bug fixes and small tweaks: 0.4.0 -> 0.4.1
 *   - new features:               0.4.1 -> 0.5.0
 * Keep server/package.json "version" the same; a unit test checks they match.
 */
(function (root, version) {
  if (typeof module === 'object' && module.exports) module.exports = version;
  else root.SINEWAVE_VERSION = version;
})(typeof self !== 'undefined' ? self : this, '0.5.0');
