// Steady traffic for the demo services, so there is always data to query.
// Not part of any service: it only makes HTTP requests.

const checkout = process.env.CHECKOUT_URL;
const inventory = process.env.INVENTORY_URL;
const perSecond = Number(process.env.REQUESTS_PER_SECOND ?? 6);

const PAYMENT_METHODS = ['card', 'card', 'card', 'wallet', 'bank_transfer'];
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const orderIds = [];

const post = (url, body) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** Weighted list of things a visitor does. */
const actions = [
  [
    4,
    async () => {
      const response = await post(`${checkout}/checkout/pay`, {
        payment_method: pick(PAYMENT_METHODS),
        item_id: `sku-${1 + Math.floor(Math.random() * 40)}`,
      });
      if (response.ok) {
        orderIds.push((await response.json()).id);
        if (orderIds.length > 200) orderIds.shift();
      }
    },
  ],
  [10, () => fetch(`${checkout}/checkout/summary`)],
  // Mostly real orders, sometimes one that does not exist.
  [
    5,
    () =>
      fetch(
        `${checkout}/checkout/orders/${Math.random() < 0.9 && orderIds.length ? pick(orderIds) : 'nope'}`,
      ),
  ],
  [
    8,
    () =>
      inventory && fetch(`${inventory}/inventory/items/sku-${1 + Math.floor(Math.random() * 40)}`),
  ],
  [2, () => inventory && fetch(`${inventory}/inventory/stock`)],
  [1, () => inventory && fetch(`${inventory}/inventory/stock/history`)],
];
const total = actions.reduce((sum, [weight]) => sum + weight, 0);

async function one() {
  let roll = Math.random() * total;
  for (const [weight, run] of actions) {
    roll -= weight;
    if (roll <= 0) {
      try {
        await run();
      } catch (error) {
        console.error(`request failed: ${error.message}`);
      }
      return;
    }
  }
}

console.log(
  `about ${perSecond} requests per second to ${checkout} and ${inventory ?? '(no inventory)'}`,
);
const timer = setInterval(one, 1000 / perSecond);
process.on('SIGTERM', () => clearInterval(timer));
