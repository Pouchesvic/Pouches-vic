'use strict';

// Small compatibility layer for the synchronous SQLite API used by this app.
// Node ships this API, so production and disposable tests do not depend on a
// separately compiled native addon matching the exact Node runtime version.
const { DatabaseSync } = require('node:sqlite');

class Database {
  constructor(filename) {
    this.database = new DatabaseSync(filename);
    this.transactionDepth = 0;
    this.savepoint = 0;
  }

  prepare(sql) { return this.database.prepare(sql); }
  exec(sql) { return this.database.exec(sql); }
  close() { return this.database.close(); }
  pragma(sql) { return this.database.exec(`PRAGMA ${sql}`); }

  transaction(work) {
    return (...args) => {
      const outermost = this.transactionDepth === 0;
      const savepoint = `pv_nested_${++this.savepoint}`;
      this.database.exec(outermost ? 'BEGIN' : `SAVEPOINT ${savepoint}`);
      this.transactionDepth++;
      try {
        const result = work(...args);
        this.transactionDepth--;
        this.database.exec(outermost ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        this.transactionDepth--;
        this.database.exec(outermost ? 'ROLLBACK' : `ROLLBACK TO SAVEPOINT ${savepoint}`);
        if (!outermost) this.database.exec(`RELEASE SAVEPOINT ${savepoint}`);
        throw error;
      }
    };
  }
}

module.exports = Database;
