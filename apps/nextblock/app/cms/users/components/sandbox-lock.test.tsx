// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * /cms/users on the public sandbox (2026-11-03). Its admin login is published, so every visitor
 * shares every account and the actions refuse every change there (actions.test.ts). The screens
 * say so before anyone tries: the create form's submit, the edit form's Save and each Delete item
 * render disabled, described (aria-describedby) by a visible note carrying the refusal's sentence.
 * Off the sandbox ('', 'false', 'TRUE', '1') the markup is what it was: no note, no description,
 * nothing disabled that was not disabled before.
 */

const mocks = vi.hoisted(() => ({
  createUser: vi.fn(),
  deleteUserAndProfile: vi.fn(),
}));

vi.mock('../actions', () => ({
  createUser: mocks.createUser,
  deleteUserAndProfile: mocks.deleteUserAndProfile,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

// Native stand-ins that keep the props the lock sets (disabled, aria-describedby).
vi.mock('@nextblock-cms/ui', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Alert: Pass,
    AlertTitle: Pass,
    AlertDescription: Pass,
    Button: ({ children, variant: _variant, size: _size, asChild: _asChild, ...props }: Record<string, any>) => (
      <button {...props}>{children}</button>
    ),
    Checkbox: ({ id, checked }: { id?: string; checked?: boolean }) => (
      <input type="checkbox" id={id} checked={checked} readOnly />
    ),
    Input: (props: Record<string, unknown>) => <input {...props} />,
    Label: ({ children, htmlFor }: { children?: ReactNode; htmlFor?: string }) => <label htmlFor={htmlFor}>{children}</label>,
    Select: Pass,
    SelectContent: Pass,
    SelectItem: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    SelectTrigger: Pass,
    SelectValue: () => null,
    Spinner: () => null,
    // Radix renders a disabled item with data-disabled and never selects it. This stand-in
    // delivers a click as a selection regardless, so the component's own check is what is tested.
    DropdownMenuItem: ({ children, disabled, onSelect, ...props }: Record<string, any>) => (
      <div
        role="menuitem"
        aria-disabled={disabled || undefined}
        data-disabled={disabled ? '' : undefined}
        onClick={(event) => onSelect?.(event)}
        {...props}
      >
        {children}
      </div>
    ),
  };
});

// The edit form's Save lives inside this libs/ecommerce component; the stand-in mirrors its
// role select (disabled by lockRole, reason underneath) and its submit button.
vi.mock('@nextblock-cms/ecommerce', () => ({
  addressesMatch: () => true,
  CustomerProfileForm: ({ email, lockRole, lockRoleReason }: { email?: string; lockRole?: boolean; lockRoleReason?: string }) => (
    <form>
      <input id="email" defaultValue={email} />
      <button type="button" role="combobox" disabled={lockRole}>
        Role
      </button>
      {lockRole ? <p data-role-lock="">{lockRoleReason || 'This is the only Admin account.'}</p> : null}
      <button type="submit">Save changes</button>
    </form>
  ),
}));
vi.mock('../../media/components/MediaPickerDialog', () => ({ default: () => null }));
vi.mock('../../components/ConfirmationModal', () => ({
  ConfirmationModal: ({ isOpen }: { isOpen: boolean }) => (isOpen ? <div role="dialog">Are you sure?</div> : null),
}));

import CreateUserForm from './CreateUserForm';
import { DeleteUserButtonClient } from './DeleteUserButton';
import UserForm from './UserForm';
import { USERS_LOCKED_IN_SANDBOX, USERS_SANDBOX_NOTE_ID } from '../sandbox-lock';

const OFF_SANDBOX = ['', 'false', 'TRUE', '1'] as const;
const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

const editProps = {
  userToEditAuth: { email: 'partner@nextblock.dev', id: USER_ID },
  userToEditProfile: { id: USER_ID, role: 'USER', full_name: 'Demo Partner' } as never,
  userToEditAddresses: { billingAddress: null, shippingAddress: null },
  formAction: async () => undefined,
};

const screens = {
  create: () => <CreateUserForm />,
  edit: () => <UserForm {...editProps} />,
  delete: () => <DeleteUserButtonClient userId={USER_ID} userEmail="partner@nextblock.dev" currentAdminId={ADMIN_ID} />,
  deleteSelf: () => <DeleteUserButtonClient userId={ADMIN_ID} userEmail="demo@nextblock.dev" currentAdminId={ADMIN_ID} />,
};

function dom(markup: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><body>${markup}</body>`, 'text/html');
}

/** The visible note the control's aria-describedby names, with the refusal's sentence. */
function expectDescribedByNote(doc: Document, control: Element | null) {
  expect(control).not.toBeNull();
  expect(control?.getAttribute('aria-describedby')).toBe(USERS_SANDBOX_NOTE_ID);
  const notes = doc.querySelectorAll(`#${USERS_SANDBOX_NOTE_ID}`);
  expect(notes).toHaveLength(1);
  expect(notes[0].textContent).toBe(USERS_LOCKED_IN_SANDBOX);
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mount(element: ReactNode): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(element);
  });
  return container;
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  mocks.createUser.mockReset();
  mocks.deleteUserAndProfile.mockReset();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllEnvs();
});

describe('on the sandbox (NEXT_PUBLIC_IS_SANDBOX=true)', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
  });

  it('renders the create form submit disabled, described by the note', () => {
    const doc = dom(renderToStaticMarkup(screens.create()));
    const submit = doc.querySelector('button[type="submit"]');
    expect(submit?.matches(':disabled')).toBe(true);
    expectDescribedByNote(doc, submit);
  });

  it('renders the edit form inside a disabled fieldset described by the note, so Save is disabled', () => {
    const doc = dom(renderToStaticMarkup(screens.edit()));
    const fieldset = doc.querySelector('fieldset');
    expect(fieldset?.hasAttribute('disabled')).toBe(true);
    expectDescribedByNote(doc, fieldset);

    const save = doc.querySelector('button[type="submit"]');
    expect(save?.closest('fieldset[disabled]')).toBe(fieldset);
    expect(save?.matches(':disabled')).toBe(true);
    expect(doc.querySelector('#email')?.matches(':disabled')).toBe(true);
    // The role select is locked too (Radix would open it on pointerdown), with the same reason.
    expect(doc.querySelector('[role="combobox"]')?.hasAttribute('disabled')).toBe(true);
    expect(doc.querySelector('[data-role-lock]')?.textContent).toBe(USERS_LOCKED_IN_SANDBOX);
  });

  it('renders every Delete item disabled, described by the list page note', () => {
    const item = dom(renderToStaticMarkup(screens.delete())).querySelector('[role="menuitem"]');
    expect(item?.hasAttribute('data-disabled')).toBe(true);
    expect(item?.getAttribute('aria-describedby')).toBe(USERS_SANDBOX_NOTE_ID);
  });

  it('never opens the delete confirmation, even when a selection reaches the item', async () => {
    const view = await mount(screens.delete());
    await act(async () => {
      view.querySelector<HTMLElement>('[role="menuitem"]')?.click();
    });
    expect(view.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.deleteUserAndProfile).not.toHaveBeenCalled();
  });
});

describe.each(OFF_SANDBOX)('off the sandbox (NEXT_PUBLIC_IS_SANDBOX=%j): unchanged', (value) => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
  });

  it('renders no note, no description and nothing newly disabled', () => {
    for (const render of Object.values(screens)) {
      const markup = renderToStaticMarkup(render());
      expect(markup).not.toContain(USERS_SANDBOX_NOTE_ID);
      expect(markup).not.toContain('aria-describedby');
      expect(markup).not.toContain('<fieldset');
    }

    const create = dom(renderToStaticMarkup(screens.create()));
    expect(create.querySelector('button[type="submit"]')?.matches(':disabled')).toBe(false);

    const edit = dom(renderToStaticMarkup(screens.edit()));
    expect(edit.querySelector('button[type="submit"]')?.matches(':disabled')).toBe(false);
    expect(edit.querySelector('[role="combobox"]')?.hasAttribute('disabled')).toBe(false);

    // Another user's Delete is live; the caller's own stays disabled, as before.
    expect(dom(renderToStaticMarkup(screens.delete())).querySelector('[role="menuitem"]')?.hasAttribute('data-disabled')).toBe(false);
    expect(dom(renderToStaticMarkup(screens.deleteSelf())).querySelector('[role="menuitem"]')?.hasAttribute('data-disabled')).toBe(true);
  });

  it('renders the same markup as with the variable unset', () => {
    const current = Object.values(screens).map((render) => renderToStaticMarkup(render()));
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
    const unset = Object.values(screens).map((render) => renderToStaticMarkup(render()));
    expect(current).toEqual(unset);
  });

  it('opens the delete confirmation for another user', async () => {
    const view = await mount(screens.delete());
    await act(async () => {
      view.querySelector<HTMLElement>('[role="menuitem"]')?.click();
    });
    expect(view.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
