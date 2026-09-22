// npm `overrides` that create-nextblock writes into every new project, and the values earlier
// releases wrote.
//
// `npm run update` moves an override that still carries one of NextBlock's OLD values to the
// current one. Any other value is the owner's own pin and is left alone. Before this, an
// existing project kept the override it was scaffolded with forever, and because an override
// wins over the template's dependency range, a release that raised `uuid` to ^14 left the
// project on ^11.
//
// Keep `current` equal to FALLBACK_OVERRIDES in apps/create-nextblock/bin/lib/fallback-overrides.js,
// and add the value it replaces to `previous` whenever one is raised. The test beside that file
// checks both: `current` against FALLBACK_OVERRIDES, and every value in its SHIPPED history
// against `previous` + `current`.
export const MANAGED_OVERRIDES = {
  glob: { current: '^13.0.6', previous: ['^10.4.5'] },
  postcss: { current: '^8.5.28', previous: ['^8.5.12', '^8.5.26'] },
  qs: { current: '^6.16.0', previous: ['^6.15.2'] },
  uuid: { current: '^14.0.2', previous: ['^11.1.1'] },
};

/**
 * Move every override that still has an earlier NextBlock default to the current default, in
 * place. A direct (dev)dependency with the same old spec moves with it: the scaffolder aligned
 * the two, and npm fails the install with EOVERRIDE when they differ.
 *
 * @param {Record<string, any>} projectPkg the project's parsed package.json
 * @param {typeof MANAGED_OVERRIDES} [managed]
 * @returns {string[]} one line per override moved, for the update log
 */
export function refreshManagedOverrides(projectPkg, managed = MANAGED_OVERRIDES) {
  const notes = [];
  const overrides = projectPkg?.overrides;
  if (!overrides || typeof overrides !== 'object') return notes;
  for (const [name, { current, previous }] of Object.entries(managed)) {
    const spec = overrides[name];
    if (typeof spec !== 'string' || !previous.includes(spec)) continue;
    overrides[name] = current;
    for (const section of ['dependencies', 'devDependencies']) {
      if (projectPkg[section]?.[name] === spec) projectPkg[section][name] = current;
    }
    notes.push(`overrides.${name} ${spec} → ${current} (NextBlock's earlier default)`);
  }
  return notes;
}
