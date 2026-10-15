// The refund screen names the processor that will really reverse the card (30 Sep 2026,
// Barnsley R3127 said "via Stripe Terminal" on an Adyen venue's kiosk sale).
import test from 'node:test';
import assert from 'node:assert/strict';
import { processorLabel, refundProcessor, refundProcessorName, PROCESSOR_NAME } from './refundProcessorLabel.js';
import { cardLegsOf } from './refundMath.js';

test('the card leg names the processor', () => {
  const check = { total: 4.8, processor: 'adyen', stripe_payment_intent_id: '52DY001790768087001.FKCSQLSKC3VKBVQ9' };
  assert.equal(processorLabel(check, cardLegsOf(check)), 'Processed via ServOS Payments');
  // A leg that names its own processor wins over the row's.
  assert.equal(refundProcessor({ processor: 'stripe' }, [{ id: 'x', processor: 'ryft' }]), 'ryft');
});

test('Barnsley R3127: no card leg and the stripe column default is never read as Stripe', () => {
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

test('a real Stripe sale with its payment intent still says Stripe Terminal', () => {
  const check = { total: 12, processor: 'stripe', stripe_payment_intent_id: 'pi_123' };
  assert.equal(processorLabel(check, cardLegsOf(check)), 'Processed via Stripe Terminal');
});

test('with no card leg, a processor written on purpose (adyen, ryft) is still named', () => {
  assert.equal(processorLabel({ processor: 'adyen' }, []), 'Processed via ServOS Payments');
  assert.equal(processorLabel({ processor: 'RYFT' }, []), 'Processed via Ryft');
  assert.equal(processorLabel({ processor: '' }, []), 'Processed on the card terminal');
  assert.equal(processorLabel({ processor: 'mystery' }, []), 'Processed on the card terminal');
  assert.equal(processorLabel(null, null), 'Processed on the card terminal');
});

test('the names', () => {
  assert.deepEqual({ ...PROCESSOR_NAME }, { stripe: 'Stripe Terminal', ryft: 'Ryft', adyen: 'ServOS Payments' });
});
