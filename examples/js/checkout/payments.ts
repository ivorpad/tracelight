/** How an order is paid. Neither gateway talks to a real processor. */

export interface Charge {
  method: 'card' | 'invoice';
  currency: string;
  reference: string;
}

export interface PaymentGateway {
  charge(amount: number, currency: string): Promise<Charge>;
}

/** Card payments settle at once. */
export class CardGateway implements PaymentGateway {
  async charge(amount: number, currency: string): Promise<Charge> {
    if (amount <= 0) throw new Error(`cannot charge ${amount} ${currency}`);
    return { method: 'card', currency, reference: `card-${Math.round(amount * 100)}` };
  }
}

/** Invoices are paid later: charging only records what is owed and when. */
export class InvoiceGateway implements PaymentGateway {
  private readonly dueDays: number;

  constructor(dueDays: number) {
    this.dueDays = dueDays;
  }

  async charge(amount: number, currency: string): Promise<Charge> {
    return { method: 'invoice', currency, reference: `inv-${this.dueDays}d-${Math.round(amount * 100)}` };
  }
}

/** The gateway a country's orders use: the call site in checkout.ts only sees `PaymentGateway`. */
export function gatewayFor(country: string): PaymentGateway {
  if (country === 'de' || country === 'nl') return new InvoiceGateway(14);
  return new CardGateway();
}
