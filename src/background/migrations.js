// One-time config migrations, applied to an EXISTING stored config on startup.
// Kept pure (no chrome APIs) so it's unit-testable; the service worker reads
// storage, calls this, and writes back only if something changed.
//
// Each migration is guarded by a marker in config.migrations so it runs once and
// never overrides a choice the user made after the migration already ran.

export function applyMigrations(stored) {
  if (!stored || typeof stored !== "object") return { config: stored, changed: false };
  const config = stored;
  const migrations = config.migrations || {};
  let changed = false;

  // Vision became on-by-default. Flip it on for configs saved before that, but
  // only once — if the user later turns it off, the marker keeps it off.
  if (!migrations.visionDefault) {
    config.settings = config.settings || {};
    if (config.settings.enableVision === false) {
      config.settings.enableVision = true;
      changed = true;
    }
    migrations.visionDefault = true;
    changed = true;
  }

  config.migrations = migrations;
  return { config, changed };
}
