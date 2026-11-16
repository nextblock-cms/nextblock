// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Review 2026-11-15: a publish warning's toast never expires and sits top right, over the block editor
 * dialog's header buttons. Clicking its Dismiss or Reload page counted as a click outside the dialog:
 * a clean editor closed, a dirty one asked whether to save. A click that starts on a toast is now
 * ignored by the dialog; any other click outside still closes it.
 */

const mocks = vi.hoisted(() => ({
  dialogContentProps: null as null | { onInteractOutside?: (event: { preventDefault: () => void; target: EventTarget | null }) => void },
}));

vi.mock('@nextblock-cms/utils', () => ({ cn: (...classes: unknown[]) => classes.filter(Boolean).join(' ') }));
vi.mock('@nextblock-cms/ui', () => {
  type Props = { children?: ReactNode; [key: string]: unknown };
  const Pass = ({ children }: Props) => <>{children}</>;
  return {
    Dialog: ({ open, children }: Props) => (open ? <>{children}</> : null),
    DialogContent: (props: Props) => {
      mocks.dialogContentProps = props as typeof mocks.dialogContentProps;
      return <div role="dialog">{props.children}</div>;
    },
    DialogTitle: Pass,
    DialogHeader: Pass,
    DialogFooter: Pass,
    DialogDescription: Pass,
    Button: ({ children, onClick }: Props) => (
      <button type="button" onClick={onClick as () => void}>
        {children}
      </button>
    ),
  };
});
vi.mock('../../../../lib/blocks/blockRegistry', () => ({ blockRegistry: {} }));

import { BlockEditorModal, isToastInteraction } from './BlockEditorModal';

let mounted: Array<{ root: Root; container: HTMLElement }> = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.dialogContentProps = null;
});

afterEach(async () => {
  for (const { root, container } of mounted) {
    await act(async () => root.unmount());
    container.remove();
  }
  mounted = [];
  document.body.innerHTML = '';
});

function Editor() {
  return <div>editor</div>;
}

async function renderModal(onClose: () => void) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      <BlockEditorModal
        block={{ type: 'text', content: { html_content: '<p>Copy</p>' } }}
        isOpen
        onClose={onClose}
        onSave={vi.fn()}
        EditorComponent={Editor}
      />
    );
  });
}

/** A button inside a toaster container, as react-hot-toast or sonner renders one. */
function toastButton(attribute: 'data-rht-toaster' | 'data-sonner-toaster') {
  const toaster = document.createElement('div');
  toaster.setAttribute(attribute, '');
  const button = document.createElement('button');
  button.textContent = 'Dismiss';
  toaster.appendChild(button);
  document.body.appendChild(toaster);
  return button;
}

describe('BlockEditorModal and toasts', () => {
  it.each(['data-rht-toaster', 'data-sonner-toaster'] as const)(
    'ignores a click that starts on a toast (%s): the editor stays open',
    async (attribute) => {
      const onClose = vi.fn();
      await renderModal(onClose);
      const preventDefault = vi.fn();

      await act(async () => {
        mocks.dialogContentProps?.onInteractOutside?.({ preventDefault, target: toastButton(attribute) });
      });

      expect(preventDefault).toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    }
  );

  it('still closes a clean editor on any other click outside', async () => {
    const onClose = vi.fn();
    await renderModal(onClose);

    await act(async () => {
      mocks.dialogContentProps?.onInteractOutside?.({ preventDefault: vi.fn(), target: document.body });
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('isToastInteraction reads only elements inside a toaster container', () => {
    expect(isToastInteraction(toastButton('data-rht-toaster'))).toBe(true);
    expect(isToastInteraction(document.body)).toBe(false);
    expect(isToastInteraction(null)).toBe(false);
    expect(isToastInteraction(window)).toBe(false);
  });
});
