// `npm run desktop:dev`: Vite dev server with hot reload, inside the Electron window.
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import electron from 'electron';

const server = await createServer({ server: { open: false } });
await server.listen();
const url = server.resolvedUrls.local[0];

const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, PLUNDER_DEV_URL: url },
});
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
