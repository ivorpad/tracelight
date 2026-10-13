/** One order: price it, charge it through whichever gateway was injected, announce it. */
import type { EventBus } from './events.ts';
import type { PaymentGateway } from './payments.ts';

export interface Line {
  sku: string;
  qty: number;
  price: number;
}

export interface Cart {
  email: string;
  country: string;
  coupon: string;
  lines: Line[];
}

export interface Receipt {
  orderId: string;
  total: number;
  currency: string;
  method: string;
  reference: string;
}

const COUPONS: Record<string, number> = { WELCOME10: 0.1 };
const TAX: Record<string, number> = { us: 0.07, de: 0.19, nl: 0.21 };

let nextOrder = 1;

export class CheckoutService {
  private readonly gateway: PaymentGateway;
  private readonly events: EventBus;

  constructor(gateway: PaymentGateway, events: EventBus) {
    this.gateway = gateway;
    this.events = events;
  }

  async placeOrder(cart: Cart): Promise<Receipt> {
    const subtotal = cart.lines.reduce((sum, line) => sum + line.qty * line.price, 0);
    const discount = COUPONS[cart.coupon] ?? 0;
    const taxRate = TAX[cart.country] ?? 0;
    const total = Math.round(subtotal * (1 - discount) * (1 + taxRate) * 100) / 100;
    const currency = cart.country === 'us' ? 'USD' : 'EUR';
    const charge = await this.gateway.charge(total, currency);
    const receipt: Receipt = { orderId: `ord-${nextOrder++}`, total, currency, method: charge.method, reference: charge.reference };
    this.events.publish('order.paid', { ...receipt, email: cart.email });
    return receipt;
  }
}
