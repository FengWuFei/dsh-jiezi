/**
 * Client half of `dsh-jiezi`.
 *
 * Registers the JieZi panel icon in the sidebar's global panellist and the
 * matching `main` key, plus the panel's copy. The bundle is a plain React
 * module loaded through `window.__ModuleLoader__`; React and the JSX runtime
 * come from the Harness browser module table.
 */

import { en, NS, zh } from './locales.js';
import { JieZiPanel } from './JieZiPanel.js';
import type { ClientContext, PanelIconProps } from './types.js';

/** Services this Client plugin needs. */
export const inject = ['slots', 'locale'];

/** Sidebar glyph: three tiles and one highlighted tile, matching the bundle icon. */
export function JieZiIcon({ size }: PanelIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', pointerEvents: 'none' }}
    >
      <g fill="currentColor">
        <rect x="3.5" y="3.5" width="7" height="7" rx="2" />
        <rect x="13.5" y="3.5" width="7" height="7" rx="2" />
        <rect x="3.5" y="13.5" width="7" height="7" rx="2" />
      </g>
      <rect x="13.5" y="13.5" width="7" height="7" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M17 15.1l.7 1.5 1.6.2-1.2 1.1.3 1.6-1.4-.8-1.4.8.3-1.6-1.2-1.1 1.6-.2z"
        fill="currentColor"
      />
    </svg>
  );
}

/** Register the sidebar entry, the main-panel view, and the panel copy. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const disposeLocale = ctx.locale.register(NS, { zh, en });
    const t = ctx.locale.bind(NS);
    const disposePanel = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist',
      id: 'jiezi',
      order: 30,
      locale: NS,
      label: () => t('panelTitle'),
    }, JieZiIcon));
    const disposeMain = ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main',
      key: 'jiezi',
      locale: NS,
    }, JieZiPanel));
    return () => {
      disposeMain();
      disposePanel();
      disposeLocale();
    };
  }, 'jiezi-builder: sidebar entry, main panel, and copy');
}
