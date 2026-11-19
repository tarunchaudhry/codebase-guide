const { DATABASE_URL } = process.env;

function query(sql) {
  return [DATABASE_URL, sql];
}

module.exports = { query };
