// Shared by SSH checks and management dialogs; never persisted outside this page.
let target = '';
const passwords = new Map(), changes = new EventTarget();
const key = row => row ? JSON.stringify([row.id, row.address, row.ssh_port, row.ssh_user]) : '';
export const sshCredentials = {
 select(row) {
  const next = key(row);
  if (next === target) return;
  target = next; this.clear();
 },
 get(row, user = row?.ssh_user) {
  return key(row) === target ? passwords.get(user) || '' : '';
 },
 set(row, user, password) {
  if (!target || key(row) !== target || !user) return;
  if (password) passwords.set(user, password); else passwords.delete(user);
  changes.dispatchEvent(new Event('change'));
 },
 clear() { passwords.clear(); changes.dispatchEvent(new Event('change')); },
 subscribe(callback) { changes.addEventListener('change', callback); }
};
window.addEventListener('pagehide', () => sshCredentials.clear());
