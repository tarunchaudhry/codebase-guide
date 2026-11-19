const db = require('./db');

/** List all orders. */
exports.listOrders = function () {
  return db.query('select * from orders');
};

exports.getOrder = async (id) => db.query(`select * from orders where id = ${id}`);
