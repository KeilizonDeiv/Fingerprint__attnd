const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// better-sqlite3 is synchronous and runs in-process — the right choice here
// because this is a single-user desktop kiosk, not a multi-client server.
// (If this ever becomes a networked multi-terminal system, that assumption
// breaks and you'd move to a real client/server DB — see README "Scaling out".)

let db = null;

function getDb(userDataPath) {
  if (db) return db;

  const dbPath = path.join(userDataPath, 'attendance.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL'); // better concurrent read/write behavior
  db.pragma('foreign_keys = ON');

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  return db;
}

module.exports = { getDb };
