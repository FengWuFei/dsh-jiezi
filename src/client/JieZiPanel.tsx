/**
 * The main-panel half of the JieZi sidebar entry: delivery bridge state, local
 * pairing QR, paired devices, recent deployments, and recent semantic
 * automation.
 *
 * Data comes only from the authenticated same-origin Host routes. Polling is
 * bounded, cleans up on unmount, and skips hidden tabs, so the panel never
 * blocks another DSH session.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  API_ROUTES,
  STATUS_POLL_MS,
  PAIRING_POLL_MS,
  type AutomationView,
  type DeploymentView,
  type DeviceView,
  type PairingView as PairingState,
  type SetupInitializeResult,
  type SetupReport,
  type StatusView,
} from '../shared/protocol.js';
import { apiGet, apiPost } from './api.js';
import { PairingView } from './PairingView.js';
import type { MainPanelProps } from './types.js';

const EMPTY_PAIRING: PairingState = {
  payload: null,
  state: 'none',
  deviceId: null,
  bridgeName: null,
  expiresAt: null,
};

/** One readable clock value without depending on the Client locale service. */
function clock(iso: string | null): string {
  if (iso === null) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function automationLabel(entry: AutomationView): string {
  return entry.action;
}

/** First-run checks and the one explicit consent action that creates keys. */
function SetupCard({ t, setup, onInitialized }: {
  t: (key: string) => string;
  setup: StatusView['setup'];
  onInitialized: () => void;
}) {
  const [report, setReport] = useState<SetupReport | null>(null);
  const [checksBusy, setChecksBusy] = useState(false);
  const [initBusy, setInitBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async (): Promise<void> => {
    setChecksBusy(true);
    const result = await apiGet<SetupReport>(API_ROUTES.setup);
    if (!mounted.current) return;
    setChecksBusy(false);
    if (result.ok) {
      setReport(result.value);
      setMessage(null);
    } else {
      setMessage(`${t('setupFailed')}: ${result.message}`);
    }
  }, [t]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; };
  }, [load]);

  const initialize = useCallback(async (): Promise<void> => {
    setInitBusy(true);
    setMessage(null);
    const result = await apiPost<SetupInitializeResult>(API_ROUTES.setup, {
      consent: true,
      tls: true,
      host: '0.0.0.0',
    });
    if (!mounted.current) return;
    setInitBusy(false);
    if (result.ok) {
      setReport(result.value.report);
      setMessage(result.value.alreadyInitialized ? t('setupAlready') : t('setupDone'));
      onInitialized();
    } else {
      setMessage(`${t('setupFailed')}: ${result.message}`);
    }
  }, [onInitialized, t]);

  return (
    <section className="jz-card jz-setup" aria-labelledby="jz-setup-title">
      <div className="jz-card-head">
        <h2 id="jz-setup-title" className="jz-card-title">{t('setupTitle')}</h2>
        <button type="button" className="jz-button" onClick={() => { void load(); }} disabled={checksBusy || initBusy}>
          {checksBusy ? t('loading') : t('runChecks')}
        </button>
      </div>
      <p className="jz-hint">{t('setupHint')}</p>
      {report !== null ? (
        <ul className="jz-checks">
          {report.checks.map((check) => (
            <li key={check.id} className={`jz-check ${check.ok ? 'jz-check-ok' : 'jz-check-bad'}`}>
              <span className="jz-check-mark" aria-hidden="true">{check.ok ? '✓' : '✕'}</span>
              <span className="jz-check-id">{check.id}</span>
              <span className="jz-muted jz-break">{check.message}</span>
            </li>
          ))}
        </ul>
      ) : <p className="jz-muted">{t('loading')}</p>}
      {report !== null && report.notes.length > 0 ? (
        <ul className="jz-notes">
          {report.notes.map((note) => <li key={note} className="jz-hint">{note}</li>)}
        </ul>
      ) : null}
      <div className="jz-actions">
        <button
          type="button"
          className="jz-button jz-button-primary"
          onClick={() => { void initialize(); }}
          disabled={initBusy || checksBusy || !setup.bridgeCliAvailable}
        >
          {initBusy ? t('setupInitializing') : t('setupInitialize')}
        </button>
      </div>
      <p className="jz-hint">{t('setupConsent')}</p>
      <p className="jz-hint">{t('setupPrereq')}</p>
      {message !== null ? <p className="jz-message" role="status">{message}</p> : null}
    </section>
  );
}

/** Latest deployments, newest first. */
function deploymentRows(deployments: DeploymentView[], t: (key: string) => string) {
  if (deployments.length === 0) {
    return <p className="jz-muted">{t('noDeployments')}</p>;
  }
  return (
    <ul className="jz-list">
      {deployments.map((entry) => (
        <li key={entry.opId} className="jz-row">
          <div className="jz-row-main">
            <span className="jz-mono">{entry.opId}</span>
            <span className="jz-muted">{entry.releaseId}</span>
          </div>
          <div className="jz-row-side">
            <span className={`jz-pill jz-pill-${entry.state}`}>{entry.state}</span>
            {entry.failureLayer !== null ? <span className="jz-badge jz-badge-warn">{entry.failureLayer}</span> : null}
            <span className="jz-muted">{clock(entry.updatedAt)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Latest automation outcomes, newest first. */
function automationRows(entries: AutomationView[], t: (key: string) => string) {
  if (entries.length === 0) {
    return <p className="jz-muted">{t('noAutomation')}</p>;
  }
  return (
    <ul className="jz-list">
      {entries.map((entry) => (
        <li key={entry.requestId} className="jz-row">
          <div className="jz-row-main">
            <span className="jz-badge">{automationLabel(entry)}</span>
            <span className="jz-mono">{entry.requestId}</span>
            {entry.appId !== null ? <span className="jz-muted">{entry.appId}</span> : null}
          </div>
          <div className="jz-row-side">
            <span className={`jz-pill jz-pill-${entry.state}`}>{entry.state}</span>
            <span className="jz-muted">{entry.nodeCount} {t('nodes')}</span>
            {entry.error !== null ? <span className="jz-error-inline">{entry.error.code}</span> : null}
            <span className="jz-muted">{clock(entry.updatedAt)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** One device row with presence, active app, and the unpair action. */
function DeviceRow({ device, t, busy, onUnpair }: {
  device: DeviceView;
  t: (key: string) => string;
  busy: boolean;
  onUnpair: (deviceId: string) => void;
}) {
  const app = device.activeApp;
  return (
    <li className="jz-device">
      <div className="jz-device-head">
        <div>
          <span className="jz-device-name">{device.name}</span>
          <span className="jz-mono jz-muted">{device.deviceId}</span>
        </div>
        <div className="jz-row-side">
          <span className={`jz-pill ${device.online ? 'jz-pill-paired' : 'jz-pill-expired'}`}>
            {device.online ? t('online') : t('offline')}
          </span>
          {device.developerMode ? <span className="jz-badge">{t('developerMode')}</span> : null}
          {device.automation ? <span className="jz-badge">{t('automation')}</span> : null}
        </div>
      </div>
      <div className="jz-device-body">
        <span className="jz-muted">{t('lastSeen')}: {clock(device.lastSeenAt)}</span>
        {app !== null && app.appId !== null ? (
          <span className="jz-muted">
            {t('activeApp')}: <span className="jz-mono">{app.appId}</span>
            {app.releaseId !== null ? <span className="jz-mono"> · {app.releaseId}</span> : null}
          </span>
        ) : (
          <span className="jz-muted">{t('noActiveApp')}</span>
        )}
        {app !== null && app.installedApps.length > 0 ? (
          <span className="jz-muted">{t('installedApps')}: {app.installedApps.length}</span>
        ) : null}
      </div>
      <div className="jz-actions jz-actions-end">
        <button type="button" className="jz-button" onClick={() => onUnpair(device.deviceId)} disabled={busy}>
          {t('unpair')}
        </button>
      </div>
    </li>
  );
}

const CSS = `
.jz-panel { height: 100%; overflow: auto; padding: 24px 28px 48px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); box-sizing: border-box; }
.jz-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
.jz-title { margin: 0; font-size: 22px; line-height: 1.2; font-weight: 600; letter-spacing: .2px; }
.jz-subtitle { margin: 4px 0 0; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.jz-header-actions { display: flex; align-items: center; gap: 8px; }
.jz-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; padding: 16px 18px; margin-bottom: 16px; }
.jz-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.jz-card-title { margin: 0; font-size: 15px; font-weight: 600; }
.jz-muted { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.jz-hint { color: var(--dsw-alias-label-tertiary); font-size: 12px; margin: 8px 0 0; }
.jz-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.jz-break { overflow-wrap: anywhere; }
.jz-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 18px; letter-spacing: 2px; font-weight: 600; }
.jz-pill { display: inline-flex; align-items: center; border-radius: 999px; padding: 2px 9px; font-size: 12px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.jz-pill-waiting { background: var(--dsw-alias-state-warn-tertiary); color: var(--dsw-alias-state-warn-label); }
.jz-pill-paired, .jz-pill-running, .jz-pill-done { background: var(--dsw-alias-state-success-secondary); color: var(--dsw-alias-label-primary); }
.jz-pill-expired, .jz-pill-failed, .jz-pill-timeout, .jz-pill-unsupported { background: var(--dsw-alias-state-error-secondary); color: var(--dsw-alias-label-primary); }
.jz-pill-pending { background: var(--dsw-alias-bg-layer-2); }
.jz-badge { display: inline-flex; align-items: center; border-radius: 6px; padding: 1px 7px; font-size: 11px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); border: 1px solid var(--dsw-alias-border-l1); }
.jz-badge-warn { color: var(--dsw-alias-state-warn-label); border-color: var(--dsw-alias-state-warn-primary); }
.jz-pairing { display: flex; gap: 20px; align-items: flex-start; flex-wrap: wrap; }
.jz-qr { padding: 10px; border-radius: 10px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); }
.jz-pairing-body { flex: 1 1 300px; min-width: 240px; }
.jz-facts { margin: 10px 0 0; display: grid; gap: 6px; }
.jz-facts div { display: grid; grid-template-columns: 92px 1fr; gap: 10px; align-items: baseline; }
.jz-facts dt { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.jz-facts dd { margin: 0; font-size: 12px; color: var(--dsw-alias-label-primary); }
.jz-actions { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
.jz-actions-end { justify-content: flex-end; margin-top: 8px; }
.jz-button { appearance: none; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 6px 12px; font-size: 13px; cursor: pointer; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.jz-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.jz-button:disabled { opacity: .55; cursor: default; }
.jz-button-primary { background: var(--dsw-alias-button-primary-fill); border-color: transparent; color: var(--dsw-alias-label-on-color); }
.jz-button-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.jz-message { margin: 10px 0 0; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.jz-error { margin: 0 0 16px; padding: 10px 12px; border-radius: 8px; font-size: 13px; background: var(--dsw-alias-state-error-secondary); color: var(--dsw-alias-label-primary); }
.jz-error-inline { color: var(--dsw-alias-state-error-primary); font-size: 12px; }
.jz-warn { margin: 0 0 16px; padding: 10px 12px; border-radius: 8px; font-size: 12px; background: var(--dsw-alias-state-warn-tertiary); color: var(--dsw-alias-state-warn-label); }
.jz-checks { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 6px; }
.jz-check { display: grid; grid-template-columns: 16px 92px minmax(0, 1fr); gap: 8px; align-items: baseline; font-size: 12px; }
.jz-check-mark { font-weight: 700; }
.jz-check-bad .jz-check-mark { color: var(--dsw-alias-state-error-primary); }
.jz-check-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--dsw-alias-label-secondary); }
.jz-notes { margin: 8px 0 0; padding-left: 18px; }
.jz-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.jz-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); }
.jz-row-main, .jz-row-side { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.jz-device { list-style: none; padding: 10px 12px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); }
.jz-device + .jz-device { margin-top: 8px; }
.jz-device-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.jz-device-name { font-size: 14px; font-weight: 600; margin-right: 8px; }
.jz-device-body { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 6px; }
.jz-foot { display: flex; justify-content: space-between; gap: 12px; color: var(--dsw-alias-label-tertiary); font-size: 11px; margin-top: 8px; }
.jz-empty { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
`;

/** Main panel: the whole JieZi surface. */
export function JieZiPanel({ t }: MainPanelProps) {
  const translate = typeof t === 'function' ? t : (key: string): string => key;
  const [status, setStatus] = useState<StatusView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [localPairing, setLocalPairing] = useState<PairingState | null>(null);
  const [dismissedSession, setDismissedSession] = useState<string | null>(null);
  const [pairBusy, setPairBusy] = useState(false);
  const [pairMessage, setPairMessage] = useState<string | null>(null);
  const [unpairing, setUnpairing] = useState<string | null>(null);
  const [deviceMessage, setDeviceMessage] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async (quiet = false): Promise<void> => {
    if (!quiet) setLoading(true);
    const result = await apiGet<StatusView>(API_ROUTES.status);
    if (!mounted.current) return;
    if (result.ok) {
      setStatus(result.value);
      setLoadError(null);
    } else {
      setLoadError(`${translate('bridgeError')}: ${result.message}`);
    }
    setLoading(false);
  }, [translate]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh(true);
    }, STATUS_POLL_MS);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  const pairing = useMemo<PairingState>(() => {
    const base = localPairing ?? status?.pairing ?? EMPTY_PAIRING;
    if (base.payload !== null && base.payload.sessionId === dismissedSession) return EMPTY_PAIRING;
    return base;
  }, [localPairing, status, dismissedSession]);

  const sessionId = pairing.payload?.sessionId ?? null;
  const pairingState = pairing.state;

  // Poll one waiting session until the bridge reports paired or expired.
  useEffect(() => {
    if (sessionId === null || pairingState !== 'waiting') return;
    let stopped = false;
    let timer: number | undefined;
    const tick = async (): Promise<void> => {
      const result = await apiGet<{ ok: true; pairing: PairingState }>(API_ROUTES.pairing, { sessionId });
      if (stopped || !mounted.current) return;
      if (result.ok) {
        setLocalPairing(result.value.pairing);
        if (result.value.pairing.state === 'paired') {
          setPairMessage(translate('refreshAfterPair'));
          void refresh(true);
          return;
        }
        if (result.value.pairing.state === 'waiting') {
          timer = window.setTimeout(() => { void tick(); }, PAIRING_POLL_MS);
          return;
        }
      }
      timer = window.setTimeout(() => { void tick(); }, PAIRING_POLL_MS * 2);
    };
    timer = window.setTimeout(() => { void tick(); }, PAIRING_POLL_MS);
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [sessionId, pairingState, refresh, translate]);

  const generate = useCallback(async (): Promise<void> => {
    setPairBusy(true);
    setPairMessage(null);
    const result = await apiPost<{ ok: true; pairing: PairingState }>(API_ROUTES.pairing, { ttlMs: 120_000 });
    if (!mounted.current) return;
    setPairBusy(false);
    if (result.ok) {
      setDismissedSession(null);
      setLocalPairing(result.value.pairing);
      setPairMessage(translate('generated'));
      setStatus((previous) => previous === null ? previous : { ...previous, pairing: result.value.pairing });
    } else {
      setPairMessage(`${translate('actionFailed')}: ${result.message}`);
    }
  }, [translate]);

  const disconnect = useCallback((): void => {
    const current = pairing.payload?.sessionId ?? null;
    setDismissedSession(current);
    setLocalPairing(EMPTY_PAIRING);
    setPairMessage(translate('disconnected'));
  }, [pairing, translate]);

  const unpair = useCallback(async (deviceId: string): Promise<void> => {
    setUnpairing(deviceId);
    setDeviceMessage(null);
    const result = await apiPost<{ ok: true }>(API_ROUTES.unpair, { deviceId });
    if (!mounted.current) return;
    setUnpairing(null);
    if (result.ok) {
      setDeviceMessage(translate('unpairDone'));
      void refresh(true);
    } else {
      setDeviceMessage(`${translate('actionFailed')}: ${result.message}`);
    }
  }, [refresh, translate]);

  const bridge = status?.bridge ?? null;
  const setup = status?.setup ?? null;
  const devices = status?.devices ?? [];
  const deployments = status?.deployments ?? [];
  const automation = status?.automation ?? [];

  return (
    <div className="jz-panel">
      <style>{CSS}</style>
      <header className="jz-header">
        <div>
          <h1 className="jz-title">{translate('panelTitle')}</h1>
          <p className="jz-subtitle">{translate('panelSubtitle')}</p>
        </div>
        <div className="jz-header-actions">
          <span className={`jz-pill ${bridge?.available === true ? 'jz-pill-paired' : 'jz-pill-expired'}`}>
            {bridge === null ? translate('loading') : bridge.available ? translate('bridgeRunning') : translate('bridgeStopped')}
          </span>
          <button type="button" className="jz-button" onClick={() => { void refresh(); }} disabled={loading}>
            {loading ? translate('loading') : translate('refresh')}
          </button>
        </div>
      </header>

      {loadError !== null ? <div className="jz-error" role="alert">{loadError}</div> : null}

      <section className="jz-card" aria-labelledby="jz-bridge-title">
        <div className="jz-card-head">
          <h2 id="jz-bridge-title" className="jz-card-title">{translate('bridge')}</h2>
          {bridge?.version !== null && bridge?.version !== undefined ? <span className="jz-badge">v{bridge.version}</span> : null}
        </div>
        {bridge !== null && bridge.available ? (
          <dl className="jz-facts">
            <div><dt>{translate('endpoint')}</dt><dd className="jz-mono jz-break">{bridge.deviceUrl ?? '—'}</dd></div>
            <div><dt>{translate('bridgeSocket')}</dt><dd className="jz-mono jz-break">{bridge.projectRoot ?? '—'}</dd></div>
          </dl>
        ) : (
          <>
            <p className="jz-muted">{bridge?.error?.message ?? translate('bridgeHint')}</p>
            <p className="jz-hint">{translate('bridgeHint')}</p>
          </>
        )}
        {bridge !== null && bridge.available && bridge.capabilities.length > 0 ? (
          <p className="jz-hint">{bridge.capabilities.join(' · ')}</p>
        ) : null}
      </section>

      {setup !== null && (!setup.initialized || !setup.bridgeCliAvailable) ? (
        <SetupCard
          t={translate}
          setup={setup}
          onInitialized={() => { void refresh(true); }}
        />
      ) : null}

      <PairingView
        t={translate}
        pairing={pairing}
        busy={pairBusy}
        message={pairMessage}
        onGenerate={() => { void generate(); }}
        onDisconnect={disconnect}
      />

      <section className="jz-card" aria-labelledby="jz-devices-title">
        <div className="jz-card-head">
          <h2 id="jz-devices-title" className="jz-card-title">{translate('devices')}</h2>
          <span className="jz-muted">{devices.length}</span>
        </div>
        {deviceMessage !== null ? <p className="jz-message" role="status">{deviceMessage}</p> : null}
        {devices.length === 0 ? (
          <p className="jz-muted">{translate('noDevices')}</p>
        ) : (
          <ul className="jz-list">
            {devices.map((device) => (
              <DeviceRow
                key={device.deviceId}
                device={device}
                t={translate}
                busy={unpairing === device.deviceId}
                onUnpair={(deviceId) => { void unpair(deviceId); }}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="jz-card" aria-labelledby="jz-deployments-title">
        <div className="jz-card-head">
          <h2 id="jz-deployments-title" className="jz-card-title">{translate('deployments')}</h2>
        </div>
        {deploymentRows(deployments, translate)}
      </section>

      <section className="jz-card" aria-labelledby="jz-automation-title">
        <div className="jz-card-head">
          <h2 id="jz-automation-title" className="jz-card-title">{translate('recentAutomation')}</h2>
        </div>
        {automationRows(automation, translate)}
      </section>

      {status !== null && status.warnings.length > 0 ? (
        <p className="jz-warn" role="status">{status.warnings.join(' · ')}</p>
      ) : null}

      <footer className="jz-foot">
        <span>{translate('panelTitle')} · jiezi.pairing.v1</span>
        <span>{status === null ? translate('loading') : `${translate('justNow')} ${clock(status.fetchedAt)}`}</span>
      </footer>
    </div>
  );
}
