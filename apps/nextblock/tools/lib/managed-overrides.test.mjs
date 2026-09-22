import { describe, expect, it } from 'vitest';

import { MANAGED_OVERRIDES, refreshManagedOverrides } from './managed-overrides.mjs';

/** A 0.20 scaffold: the CLI wrote these overrides and aligned the direct deps to them. */
function scaffoldFrom020() {
  return {
    dependencies: { next: '^16.2.0', uuid: '^11.1.1' },
    devDependencies: { postcss: '^8.5.26' },
    overrides: {
      postcss: '^8.5.26',
      qs: '^6.15.2',
      uuid: '^11.1.1',
      glob: '^13.0.6',
      keygrip: 'npm:keygrip@latest',
    },
  };
}

describe('refreshManagedOverrides', () => {
  it('moves every earlier NextBlock default to the current one', () => {
    const pkg = scaffoldFrom020();
    const notes = refreshManagedOverrides(pkg);

    expect(pkg.overrides).toEqual({
      postcss: MANAGED_OVERRIDES.postcss.current,
      qs: MANAGED_OVERRIDES.qs.current,
      uuid: MANAGED_OVERRIDES.uuid.current,
      glob: '^13.0.6',
      keygrip: 'npm:keygrip@latest',
    });
    expect(notes).toEqual([
      `overrides.postcss ^8.5.26 → ${MANAGED_OVERRIDES.postcss.current} (NextBlock's earlier default)`,
      `overrides.qs ^6.15.2 → ${MANAGED_OVERRIDES.qs.current} (NextBlock's earlier default)`,
      `overrides.uuid ^11.1.1 → ${MANAGED_OVERRIDES.uuid.current} (NextBlock's earlier default)`,
    ]);
  });

  it('moves a direct dependency the scaffolder aligned to the old override, so npm sees no EOVERRIDE', () => {
    const pkg = scaffoldFrom020();
    refreshManagedOverrides(pkg);

    expect(pkg.dependencies.uuid).toBe(pkg.overrides.uuid);
    expect(pkg.devDependencies.postcss).toBe(pkg.overrides.postcss);
    expect(pkg.dependencies.next).toBe('^16.2.0');
  });

  it("keeps an override the owner chose, and the dependency pinned to it", () => {
    const pkg = {
      dependencies: { uuid: '^11.0.0' },
      overrides: { uuid: '^11.0.0', postcss: '8.5.20', qs: { 'side-channel': '^1.1.0' } },
    };
    expect(refreshManagedOverrides(pkg)).toEqual([]);
    expect(pkg).toEqual({
      dependencies: { uuid: '^11.0.0' },
      overrides: { uuid: '^11.0.0', postcss: '8.5.20', qs: { 'side-channel': '^1.1.0' } },
    });
  });

  it('leaves a dependency alone when it differs from the old override', () => {
    const pkg = { dependencies: { uuid: '^9.0.0' }, overrides: { uuid: '^11.1.1' } };
    refreshManagedOverrides(pkg);
    expect(pkg.overrides.uuid).toBe(MANAGED_OVERRIDES.uuid.current);
    expect(pkg.dependencies.uuid).toBe('^9.0.0');
  });

  it('does nothing without overrides and is idempotent', () => {
    expect(refreshManagedOverrides({ dependencies: { uuid: '^11.1.1' } })).toEqual([]);
    expect(refreshManagedOverrides({})).toEqual([]);

    const pkg = scaffoldFrom020();
    refreshManagedOverrides(pkg);
    const once = structuredClone(pkg);
    expect(refreshManagedOverrides(pkg)).toEqual([]);
    expect(pkg).toEqual(once);
  });

  it('never lists the current value as an earlier one', () => {
    for (const [name, { current, previous }] of Object.entries(MANAGED_OVERRIDES)) {
      expect(previous, name).not.toContain(current);
    }
  });
});
