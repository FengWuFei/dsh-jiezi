/**
 * Pairing section of the JieZi panel: local QR, waiting/paired/expired state,
 * and the regenerate/disconnect actions. The payload comes from the Host route
 * unchanged; the Client never builds an endpoint or talks to the phone.
 */

import { pairingPayloadText, type PairingView as PairingState } from '../shared/protocol.js';
import { QrCode } from './qr.js';

export interface PairingViewProps {
  t: (key: string) => string;
  pairing: PairingState;
  busy: boolean;
  message: string | null;
  onGenerate: () => void;
  onDisconnect: () => void;
}

function statusLabel(t: (key: string) => string, state: PairingState['state']): string {
  if (state === 'waiting') return t('pairingWaiting');
  if (state === 'paired') return t('pairingPaired');
  if (state === 'expired') return t('pairingExpired');
  return t('pairing');
}

/** One pairing card: QR while waiting, outcome once paired or expired. */
export function PairingView({ t, pairing, busy, message, onGenerate, onDisconnect }: PairingViewProps) {
  const payload = pairing.payload;
  const waiting = pairing.state === 'waiting' && payload !== null;
  const paired = pairing.state === 'paired';
  const expired = pairing.state === 'expired';

  return (
    <section className="jz-card" aria-labelledby="jz-pairing-title">
      <div className="jz-card-head">
        <h2 id="jz-pairing-title" className="jz-card-title">{t('pairing')}</h2>
        <span className={`jz-pill jz-pill-${pairing.state}`}>{statusLabel(t, pairing.state)}</span>
      </div>

      {waiting && payload !== null ? (
        <div className="jz-pairing">
          <div className="jz-qr">
            <QrCode text={pairingPayloadText(payload)} size={232} label={t('pairing')} />
          </div>
          <div className="jz-pairing-body">
            <p className="jz-muted">{t('pairingWaitingBody')}</p>
            <dl className="jz-facts">
              <div><dt>{t('endpoint')}</dt><dd className="jz-mono">{payload.endpoint}</dd></div>
              <div><dt>{t('code')}</dt><dd className="jz-code">{payload.code}</dd></div>
              <div><dt>{t('fingerprint')}</dt><dd className="jz-mono jz-break">{payload.certificateFingerprint ?? '—'}</dd></div>
              <div><dt>{t('expires')}</dt><dd>{payload.expiresAt}</dd></div>
            </dl>
            <p className="jz-hint">{t('scanTip')}</p>
            <p className="jz-hint">{t('disconnectHint')}</p>
          </div>
        </div>
      ) : (
        <div className="jz-pairing-empty">
          <p className="jz-muted">{paired ? `${t('pairingPaired')} · ${pairing.deviceId ?? ''}` : expired ? t('pairingExpired') : t('pairingIdle')}</p>
          {!paired && !expired ? <p className="jz-hint">{t('scanTip')}</p> : null}
        </div>
      )}

      {message !== null ? <p className="jz-message" role="status">{message}</p> : null}

      <div className="jz-actions">
        <button type="button" className="jz-button jz-button-primary" onClick={onGenerate} disabled={busy}>
          {t('regenerate')}
        </button>
        {waiting ? (
          <button type="button" className="jz-button" onClick={onDisconnect} disabled={busy}>
            {t('disconnect')}
          </button>
        ) : null}
      </div>
    </section>
  );
}
