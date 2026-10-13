/**
 * A checkout shaped like a larger service, for learning code you did not write. This file wires
 * the parts: checkout.ts prices and charges an order without knowing which gateway it holds,
 * payments.ts picks the gateway by country, and events.ts delivers `order.paid` on a later turn
 * of the event loop, where the receipt handler below runs. Nothing leaves the process unless
 * CHECKOUT_OUTBOX names a file, which then gets one line per receipt sent: a visible side effect.
 * CHECKOUT_COUNTRY stands in for `--country` where no arguments reach the program (the browser page).
 *
 *     node main.ts --country de --coupon WELCOME10
 *     tracelight run main.ts --save run.json -- --country de
 *     tracelight debug main.ts --at placeOrder --args --country de
 *     CHECKOUT_COUNTRY=de tracelight web main.ts --no-run
 */
import { appendFileSync } from 'node:fs';
import { CheckoutService, type Cart } from './checkout.ts';
import { EventBus } from './events.ts';
import { gatewayFor } from './payments.ts';

function option(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

function sendReceipt(event: Record<string, unknown>): void {
  const line = `receipt ${event.orderId} to ${event.email}: ${event.total} ${event.currency} by ${event.method}`;
  if (process.env.CHECKOUT_OUTBOX) appendFileSync(process.env.CHECKOUT_OUTBOX, line + '\n');
  console.log(line);
}

const country = option('country', process.env.CHECKOUT_COUNTRY ?? 'us');
const coupon = option('coupon', '');

const bus = new EventBus();
bus.subscribe('order.paid', sendReceipt);
const checkout = new CheckoutService(gatewayFor(country), bus);

const cart: Cart = {
  email: 'ana@example.test',
  country,
  coupon,
  lines: [{ sku: 'KB-01', qty: 2, price: 49.5 }, { sku: 'USB-C', qty: 3, price: 9.99 }],
};

const receipt = await checkout.placeOrder(cart);
console.log('placed', receipt.orderId, receipt.total, receipt.currency, receipt.reference);
await bus.idle();
