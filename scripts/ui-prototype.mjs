// SPDX-License-Identifier: AGPL-3.0-only
// THROWAWAY fixture host. Never imported by the Worker or included in its build.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const html = await readFile(new URL('../src/ui.prototype.html', import.meta.url));
createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path !== '/' && path !== '/operator') { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(html);
}).listen(4177, '127.0.0.1', () => console.log('Prototype: http://127.0.0.1:4177/operator?variant=A'));
