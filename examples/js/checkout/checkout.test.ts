/** The checkout's own tests: a `node:test` file is a program, so `tracelight debug` can enter it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CheckoutService, type Cart } from './checkout.ts';
import { EventBus } from './events.ts';
import { gatewayFor } from './payments.ts';

const cart = (country: string, coupon = ''): Cart => ({ email: 'ana@example.test', country, coupon, lines: [{ sku: 'KB-01', qty: 2, price: 49.5 }] });

test('a German order is invoiced in euros with VAT', async () => {
  const receipt = await new CheckoutService(gatewayFor('de'), new EventBus()).placeOrder(cart('de'));
  assert.deepEqual([receipt.method, receipt.currency, receipt.total], ['invoice', 'EUR', 117.81]);
});

test('a coupon comes off a US card payment before tax', async () => {
  const receipt = await new CheckoutService(gatewayFor('us'), new EventBus()).placeOrder(cart('us', 'WELCOME10'));
  assert.deepEqual([receipt.method, receipt.currency, receipt.total], ['card', 'USD', 95.34]);
});

test('the receipt event arrives after placeOrder has returned', async () => {
  const bus = new EventBus();
  const seen: string[] = [];
  bus.subscribe('order.paid', (event) => seen.push(String(event.orderId)));
  const receipt = await new CheckoutService(gatewayFor('us'), bus).placeOrder(cart('us'));
  assert.deepEqual(seen, []);
  await bus.idle();
  assert.deepEqual(seen, [receipt.orderId]);
});
