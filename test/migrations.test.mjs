import { applyMigrations } from "../src/background/migrations.js";

let fail = 0;
const ok = (c, m) => { console.log((c ? "ok  : " : "FAIL: ") + m); if (!c) fail = 1; };

// Pre-existing config with vision explicitly off → flipped on + marked.
let r = applyMigrations({ settings: { enableVision: false, autonomy: "ask" } });
ok(r.changed === true, "flips a pre-existing vision-off config");
ok(r.config.settings.enableVision === true, "enableVision becomes true");
ok(r.config.settings.autonomy === "ask", "leaves other settings untouched");
ok(r.config.migrations.visionDefault === true, "sets the migration marker");

// Config that already had vision on → only the marker is added.
r = applyMigrations({ settings: { enableVision: true } });
ok(r.config.settings.enableVision === true, "leaves vision-on config on");
ok(r.config.migrations.visionDefault === true, "marks it migrated");

// Already migrated → no changes, and a later user opt-out is respected.
r = applyMigrations({ settings: { enableVision: false }, migrations: { visionDefault: true, maxSteps100: true } });
ok(r.changed === false, "does not re-run once migrated");
ok(r.config.settings.enableVision === false, "respects a user's later vision-off choice");

// Step limit: the old default 25 becomes 100, once; a user's own value stays.
r = applyMigrations({ settings: { maxSteps: 25 }, migrations: { visionDefault: true } });
ok(r.changed === true && r.config.settings.maxSteps === 100, "lifts the old 25-step default to 100");
ok(r.config.migrations.maxSteps100 === true, "marks the step migration");
r = applyMigrations({ settings: { maxSteps: 40 }, migrations: { visionDefault: true } });
ok(r.config.settings.maxSteps === 40, "keeps a step limit the user chose");
r = applyMigrations({ settings: { maxSteps: 25 }, migrations: { visionDefault: true, maxSteps100: true } });
ok(r.changed === false && r.config.settings.maxSteps === 25, "a 25 chosen after the migration stays");

// Fresh / empty inputs are safe.
ok(applyMigrations(null).changed === false, "null config is safe");
ok(applyMigrations({}).config.migrations.visionDefault === true, "empty config gets marked (no settings to flip)");

console.log(fail ? "\nSOME MIGRATION TESTS FAILED" : "\nALL MIGRATION TESTS PASSED");
process.exit(fail);
