// Throwaway local-only renderer; never imports the Worker or sends real mutations.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const path = new URL('../src/ui.prototype.html', import.meta.url);
const port = Number(process.env.PROTOTYPE_PORT || 4173);
createServer(async (request, response) => {
  const route = new URL(request.url, 'http://localhost').pathname;
  if (request.method !== 'GET' || !['/', '/operator'].includes(route)) {
    response.writeHead(404).end(); return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(await readFile(path));
}).listen(port, '127.0.0.1', () => console.log(`Prototype: http://localhost:${port}/?variant=ledger`));
