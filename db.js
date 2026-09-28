const fs = require('fs');
const path = require('path');

const DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DIR, { recursive: true });
const FILE = path.join(DIR, 'db.json');

let data = { users: {}, tickets: {}, ticketCounter: 0, admins: {} };
try { data = { ...data, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch (_) {}

let timer;
function save() {
  clearTimeout(timer);
  timer = setTimeout(() => fs.writeFile(FILE, JSON.stringify(data), () => {}), 500);
}

module.exports = {
  addUser(u) {
    if (!data.users[u.id]) {
      data.users[u.id] = { name: u.first_name || '', username: u.username || '', joined: Date.now() };
      save();
    }
  },
  addAdmin(id) { data.admins[id] = Date.now(); save(); },
  removeAdmin(id) { delete data.admins[id]; save(); },
  adminIds: () => Object.keys(data.admins),
  isAdmin: (id) => Object.prototype.hasOwnProperty.call(data.admins, String(id)),
  allUserIds: () => Object.keys(data.users),
  count: () => Object.keys(data.users).length,
  newTicket(userId, text) {
    const id = ++data.ticketCounter;
    data.tickets[id] = { userId, text, open: true, created: Date.now() };
    save();
    return id;
  },
  getTicket: (id) => data.tickets[id],
  closeTicket(id) { if (data.tickets[id]) { data.tickets[id].open = false; save(); } },
  openTickets: () => Object.values(data.tickets).filter((t) => t.open).length,
};
