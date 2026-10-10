interface Order { id: number; qty: number; price: number }

function total(order: Order): number {
  const amount: number = order.qty * order.price;
  return amount;
}

const orders: Order[] = [{ id: 1, qty: 2, price: 5 }, { id: 2, qty: 1, price: 7 }];
let grand = 0;
for (const o of orders) {
  grand += total(o);
}
console.log('grand', grand);
export {};
