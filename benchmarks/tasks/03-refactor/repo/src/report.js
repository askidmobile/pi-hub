export function invoiceLine(item) {
  const sign = item.cents < 0 ? "-" : "";
  const amount = (Math.abs(item.cents) / 100).toFixed(2);
  return `${item.name}: ${sign}${amount} ${item.currency}`;
}

export function total(items, currency) {
  const cents = items.reduce((sum, i) => sum + i.cents, 0);
  const sign = cents < 0 ? "-" : "";
  const amount = (Math.abs(cents) / 100).toFixed(2);
  return `Total: ${sign}${amount} ${currency}`;
}

export function refund(cents, currency) {
  const sign = -cents < 0 ? "-" : "";
  const amount = (Math.abs(cents) / 100).toFixed(2);
  return `Refund: ${sign}${amount} ${currency}`;
}
