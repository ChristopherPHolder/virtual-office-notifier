import { Migrator } from "effect/sql";

// Keyed `<id>_<name>` and run once each, in id order, inside the `office`
// schema. They only ever add: nothing stored is ever deleted. Inlined rather
// than read from disk, because the VM only gets the bundled main.js.
export const migrations = Migrator.fromRecord({});
