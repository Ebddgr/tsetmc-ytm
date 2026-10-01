// Dry-run payload server: serves content.js (as base64), seed.json and
// styles.css to the TSETMC preview tab over loopback HTTP so the payloads
// never have to be transcribed through tool calls.
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const port = 8765;

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  const route = (req.url || '/').split('?')[0];
  if (route === '/' || route === '/content.b64') {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(fs.readFileSync(path.join(root, 'content.js')).toString('base64'));
    return;
  }
  if (route === '/seed.json' || route === '/styles.css') {
    const name = route.slice(1);
    res.setHeader('Content-Type', name === '/seed.json'
      ? 'application/json; charset=utf-8'
      : 'text/css; charset=utf-8');
    res.end(fs.readFileSync(path.join(root, name)));
    return;
  }
  res.statusCode = 404;
  res.end('not found');
});

server.listen(port, '127.0.0.1', () => {
  console.log('dry-run payload server on http://127.0.0.1:' + port);
});
