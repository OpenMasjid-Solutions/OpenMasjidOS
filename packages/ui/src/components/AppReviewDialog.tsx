// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * What the dashboard says about an app the platform is holding.
 *
 * A restore writes `apps/` straight to disk without passing the install-time
 * risk gate, so a compose that arrived in a handed-over backup can ask for
 * powerful permissions nobody agreed to. The platform records that verdict and
 * refuses to start the app; this is where an admin reads it.
 *
 * It lives in one component on purpose. There are two Start buttons (the card's
 * ⋮ menu and the app's own page), and a consent dialog that differed between
 * them — a missing warning, a pre-ticked box — would be a security difference
 * decided by which button the admin happened to press.
 *
 * THREE OUTCOMES, not one. The first cut showed every held app the same
 * tickbox-and-"Start anyway", including refusals — which the server will refuse
 * however emphatically they are agreed to. That left the admin in a loop: tick,
 * confirm, get an error, tick again, with nothing saying the app can never
 * start or what to do instead. A dialog whose only enabled action is guaranteed
 * to fail is worse than no dialog.
 */
import { useTranslation } from 'react-i18next';
import { Modal } from './Modal';
import type { AppReview } from '../lib/types';
import { CheckboxField } from './CheckboxField';

/** The body text differs per kind: telling someone their app "asks for powerful
 *  permissions" when in truth we could not parse the file at all is simply untrue. */
const BODY: Record<AppReview['kind'], string> = {
  danger: 'appReview.bodyDanger',
  refusal: 'appReview.bodyRefusal',
  unreadable: 'appReview.bodyUnreadable',
};

export function AppReviewDialog({
  open,
  appName,
  review,
  pending,
  acknowledged,
  onAcknowledgedChange,
  onConfirm,
  onClose,
}: {
  open: boolean;
  appName: string;
  review: AppReview | null;
  pending: boolean;
  acknowledged: boolean;
  onAcknowledgedChange: (v: boolean) => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const refused = review?.kind === 'refusal';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={refused ? t('appReview.refusedTitle', { name: appName }) : t('appReview.title', { name: appName })}
    >
      <p>{t(BODY[review?.kind ?? 'danger'])}</p>

      {/* EVERY finding, not just the first. Agreeing to one of five risks is not
          agreeing to the app, and the tickbox below claims they read all of it. */}
      {review && review.reasons.length > 0 && (
        <ul className="app-review__reasons">
          {review.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}

      {refused ? (
        <>
          <p>{t('appReview.refusedNext')}</p>
          <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end', marginTop: '1rem' }}>
            <button className="btn" onClick={onClose}>
              {t('common.close')}
            </button>
          </div>
        </>
      ) : (
        <>
          <p>{t('appReview.provenance')}</p>
          <CheckboxField
            id="app-review-ack"
            checked={acknowledged}
            onChange={onAcknowledgedChange}
            align="start"
          >
            {t('appReview.ack')}
          </CheckboxField>
          {pending ? (
            <p style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
              <span className="spinner" /> {t('appReview.starting')}
            </p>
          ) : (
            <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end' }}>
              <button className="btn" onClick={onClose}>
                {t('common.cancel')}
              </button>
              {/* Disabled until the box is ticked, so agreeing is an action
                  rather than the default. Danger styling because this really is
                  the click that runs it. */}
              <button className="btn btn--danger" disabled={!acknowledged} onClick={onConfirm}>
                {t('appReview.startAnyway')}
              </button>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
