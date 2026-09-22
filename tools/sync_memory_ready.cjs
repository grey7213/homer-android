// Synchronize the readiness hook into the checked-in upstream Bun bundle.
// A full upstream Bun build includes the same hook from index.js automatically.
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(__dirname, '../sillytavern-runtime/public/scripts/extensions/third-party/SillyTavern-MemoryBooks/index.build.js');
const input = fs.readFileSync(file, 'utf8');
if (!input.includes('data-homer-ready')) {
  const re = /\.on\("click",[A-Za-z_$][\w$]*\.menuItem,[A-Za-z_$][\w$]*\)/g;
  if ([...input.matchAll(re)].length !== 1) throw Error('Upstream bundle changed; rebuild with Bun instead');
  fs.writeFileSync(file, input.replace(re, '$&,document.querySelector("#stmb-menu-item")?.setAttribute("data-homer-ready","true")'));
}
console.log('Memory readiness bundle synchronized');
