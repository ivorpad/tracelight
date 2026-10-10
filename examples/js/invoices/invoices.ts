const CSV = `name,tier,sku,qty,price
Ana,gold,KB-01,2,49.50
Ben,silver,MON-27,1,"1,299.00"
Cy,bronze,USB-C,3,9.99`;

interface Item { sku: string; qty: number; unitPrice: number }
interface Order { name: string; tier: string; items: Item[] }

const DISCOUNTS: Record<string, { rate: number }> = { gold: { rate: 0.1 }, silver: { rate: 0.05 } };

function parsePrice(text: string): number {
  return text.includes(',') ? (text as unknown as number) : Number(text);
}

function parseOrders(csv: string): Order[] {
  const orders: Order[] = [];
  for (const row of csv.split('\n').slice(1)) {
    const cells = row.match(/("[^"]*"|[^,]+)/g)!.map((c) => c.replace(/"/g, ''));
    const [name, tier, sku, qty, price] = cells;
    orders.push({ name, tier, items: [{ sku, qty: Number(qty), unitPrice: parsePrice(price) }] });
  }
  return orders;
}

function subtotal(items: Item[]): string {
  let sum = 0;
  for (const item of items) sum += item.qty * item.unitPrice;
  return sum.toFixed(2);
}

function invoiceTotal(order: Order): number {
  const discount = DISCOUNTS[order.tier].rate;
  return Number(subtotal(order.items)) * (1 - discount);
}

function main(): void {
  for (const order of parseOrders(CSV)) {
    try {
      console.log(order.name, invoiceTotal(order));
    } catch (e) {
      // skip a bad order
    }
  }
}

main();
