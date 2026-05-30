const Datastore = require("@seald-io/nedb");
const path = require("path");
const bcrypt = require("bcryptjs");

const DB_DIR = path.join(__dirname, "data");

const db = {
  users: new Datastore({ filename: path.join(DB_DIR, "users.db"), autoload: true }),
  rooms: new Datastore({ filename: path.join(DB_DIR, "rooms.db"), autoload: true }),
  lots:  new Datastore({ filename: path.join(DB_DIR, "lots.db"),  autoload: true }),
  bids:  new Datastore({ filename: path.join(DB_DIR, "bids.db"),  autoload: true }),
};

// indexes
db.users.ensureIndex({ fieldName: "email", unique: true });
db.rooms.ensureIndex({ fieldName: "createdAt" });
db.lots.ensureIndex({ fieldName: "roomId" });
db.bids.ensureIndex({ fieldName: "lotId" });

// seed admin ถ้ายังไม่มี
db.users.findOne({ role: "admin" }, (err, doc) => {
  if (!doc) {
    const hash = bcrypt.hashSync("admin1234", 10);
    db.users.insert({
      email: "admin@bidhaus.com",
      password: hash,
      name: "Admin",
      role: "admin",       // admin | seller | buyer
      status: "approved",  // approved | pending | rejected
      createdAt: new Date(),
    }, () => console.log("🔑 Admin created: admin@bidhaus.com / admin1234"));
  }
});

// promisify helpers
const find   = (col, q={}, sort={}) => new Promise((res,rej) => db[col].find(q).sort(sort).exec((e,d)=> e?rej(e):res(d)));
const findOne = (col, q)            => new Promise((res,rej) => db[col].findOne(q,(e,d)=> e?rej(e):res(d)));
const insert  = (col, doc)          => new Promise((res,rej) => db[col].insert(doc,(e,d)=> e?rej(e):res(d)));
const update  = (col, q, upd, opt={}) => new Promise((res,rej) => db[col].update(q,upd,opt,(e,n)=> e?rej(e):res(n)));
const remove  = (col, q, opt={})    => new Promise((res,rej) => db[col].remove(q,opt,(e,n)=> e?rej(e):res(n)));

module.exports = { db, find, findOne, insert, update, remove };
