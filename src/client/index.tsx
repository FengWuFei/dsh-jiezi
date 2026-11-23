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

/**
 * Sidebar glyph: three filled tiles and one open slot, the same 2×2 grid as the
 * bundle icon. The sidebar renders panellist glyphs at 16–18px, where a star
 * inside a 5px tile only ever resolves to a smudge, so the slot carries no
 * detail; the silhouette alone keeps the two marks one family.
 */
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
        <rect x="3" y="3" width="7.6" height="7.6" rx="2.2" />
        <rect x="13.4" y="3" width="7.6" height="7.6" rx="2.2" />
        <rect x="3" y="13.4" width="7.6" height="7.6" rx="2.2" />
      </g>
      <rect x="13.4" y="13.4" width="7.6" height="7.6" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
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
