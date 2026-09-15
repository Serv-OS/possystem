/**
 * KioskPhoneSheet: README 6 phone keypad sheet. One number for points and the ready text.
 *
 * PRIVACY (README): the number is never looked up here and nothing about an account is
 * shown. It is stored as digits and only ever echoed back masked elsewhere.
 * Rules (region, grouping, validity) are in lib/kioskPhone.js.
 */
import { useState } from 'react';
import { t } from '../../lib/i18n';
import { kioskPhoneDisplay, kioskPhoneMaxLength, kioskPhoneValid } from '../../lib/kioskPhone';
import { KioskBottomSheet, KioskSheetHead } from './KioskChrome';
import KioskKeypad from './KioskKeypad';

export default function KioskPhoneSheet({ region, initialDigits = '', subKey, onConfirm, onRemove, onClose }) {
  const [digits, setDigits] = useState(initialDigits || '');
  const valid = kioskPhoneValid(digits, region);
  return (
    <KioskBottomSheet label={t('k2.phone.title')} onClose={onClose}>
      <KioskSheetHead title={t('k2.phone.title')} sub={t(subKey)} onClose={onClose} />
      <KioskKeypad
        value={digits}
        onChange={setDigits}
        maxLength={kioskPhoneMaxLength(region)}
        placeholder={t(region === 'us' ? 'k2.phone.placeholderUS' : 'k2.phone.placeholderUK')}
        placeholderMono
        format={(d) => kioskPhoneDisplay(d, region)}
        confirmLabel={t('k2.phone.confirm')}
        canConfirm={valid}
        onConfirm={(d) => onConfirm(d)}
      />
      {initialDigits ? (
        <button
          type="button"
          onClick={onRemove}
          style={{ border: '2px solid var(--k2Hairline)', background: '#FFFFFF', borderRadius: 26, height: 104, fontSize: 26, fontWeight: 700, color: 'var(--k2InkBody)', cursor: 'pointer' }}
        >{t('k2.phone.remove')}</button>
      ) : null}
    </KioskBottomSheet>
  );
}
