function add(a, b) {
  const sum = a + b;
  return sum;
}

const totals = [];
for (let i = 0; i < 3; i++) {
  totals.push(add(i, 10));
}
console.log('totals', totals.join(','));
