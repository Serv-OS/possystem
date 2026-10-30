// The refund screen names the processor that will really reverse the card (30 Sep 2026,
// Barnsley R3127 named a processor the venue never used on an Adyen venue's kiosk sale).
// ServOS works with Adyen only (Drop D, 29 Oct 2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import { processorLabel, refundProcessor, refundProcessorName, PROCESSOR_NAME } from './refundProcessorLabel.js';
import { cardLegsOf } from './refundMath.js';

test('the card leg names the processor', () => {
  const check = { total: 4.8, processor: 'adyen', stripe_payment_intent_id: '52DY001790768087001.FKCSQLSKC3VKBVQ9' };
  assert.equal(processorLabel(check, cardLegsOf(check)), 'Processed via ServOS Payments');
  // A leg that names its own processor wins over the row's.
  assert.equal(refundProcessor({ processor: 'mystery' }, [{ id: 'x', processor: 'adyen' }]), 'adyen');
});

test('Barnsley R3127: no card leg and the old stripe column default is never read as a processor', () => {
  const check = { total: 5.5, processor: 'stripe', stripe_payment_intent_id: null, tenders: null };
  const legs = cardLegsOf(check);
  assert.deepEqual(legs, []);
  assert.equal(refundProcessor(check, legs), null);
  assert.equal(refundProcessorName(check, legs), null);
  assert.equal(processorLabel(check, legs), 'Processed on the card terminal');
});

test('once linked, the same sale says ServOS Payments', () => {
  const linked = {
    total: 5.5, processor: 'adyen', stripe_payment_intent_id: '52DY001790767848000.CH7MJ6RXFPS9QMG3',
    tenders: [{ method: 'card', amount: 5.5, tip: 0, psp_ref: '52DY001790767848000.CH7MJ6RXFPS9QMG3', processor: 'adyen' }],
  };
  assert.equal(processorLabel(linked, cardLegsOf(linked)), 'Processed via ServOS Payments');
});

test('an old sale with a card leg on a processor ServOS no longer works with is named as such', () => {
  const check = { total: 12, processor: 'stripe', stripe_payment_intent_id: 'pi_123' };
  assert.equal(processorLabel(check, cardLegsOf(check)), 'Processed via Stripe (no longer used)');
  assert.equal(processorLabel({ processor: 'RYFT' }, []), 'Processed via Ryft (no longer used)');
});

test('with no card leg, a processor written on purpose is still named; nothing else is', () => {
  assert.equal(processorLabel({ processor: 'adyen' }, []), 'Processed via ServOS Payments');
  assert.equal(processorLabel({ processor: '' }, []), 'Processed on the card terminal');
  assert.equal(processorLabel({ processor: 'mystery' }, []), 'Processed on the card terminal');
  assert.equal(processorLabel(null, null), 'Processed on the card terminal');
});

test('the names', () => {
  assert.deepEqual({ ...PROCESSOR_NAME }, { adyen: 'ServOS Payments', stripe: 'Stripe (no longer used)', ryft: 'Ryft (no longer used)' });
});
