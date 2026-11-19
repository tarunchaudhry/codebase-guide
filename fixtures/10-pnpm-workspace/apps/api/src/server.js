const { formatPrice } = require('@acme/shared');
const handlers = require('./handlers');

const port = process.env.PORT || 3000;

function start() {
  const plugin = require(process.env.PLUGIN_PATH);
  handlers.listOrders();
  console.log(formatPrice(1), port, plugin);
}

module.exports = { start };
