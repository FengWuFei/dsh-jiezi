/**
 * Local type faces for the DSH Client context and slot registrations this
 * plugin uses. The bundle is plain React; it does not import Harness packages,
 * so these structural types describe exactly the calls made at runtime.
 */

import type { ComponentType } from 'react';

/** One slot registration options object, as accepted by the slot service. */
export interface SlotOptions {
  name: string;
  id?: string;
  key?: string;
  order?: number;
  locale?: string;
  label?: string | (() => string);
}

/** The subset of the Client context this plugin uses. */
export interface ClientContext {
  effect(factory: () => void | (() => void), label?: string): void;
  locale: {
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void;
    bind(namespace: string): (key: string) => string;
  };
  slots: {
    inject(owner: string, callback: () => (() => void) | void): () => void;
    register(options: SlotOptions, component: ComponentType<any>): () => void;
  };
}

/** Standard panel props the shell supplies for any main panel. */
export interface MainPanelProps {
  t: (key: string) => string;
}

/** Standard icon props the sidebar supplies for a panellist entry. */
export interface PanelIconProps {
  size: number;
  active: boolean;
}
