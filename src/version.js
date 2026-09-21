// Single source of truth for the version shown in the app UI (nav bar).
// Lives under src/ deliberately — the NOVAAPP01 release pipeline's overlay
// step only ships src/, views/, and public/ into new container images; the
// root package.json is baked in once at base-image build time and never
// updates on a routine release, so reading the version from package.json
// at runtime went stale after the first overlay-only deploy. Bump this
// constant on every release instead (and keep package.json in sync too,
// for normal npm/tooling purposes — it just isn't the runtime source of
// truth for what's displayed).
module.exports = '0.0.8';
