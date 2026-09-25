const path = require('node:path');
module.exports = {
  content: [path.resolve(__dirname, '../../frontend/**/*.{html,js,mjs}').replaceAll('\\', '/'), '!../../frontend/assets/vendor/**'],
  theme: { extend: {} }, plugins: [],
};
