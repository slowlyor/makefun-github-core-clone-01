// The lifecycle the trial harness drives (RULES.txt): bind an ephemeral port, POST it to
// $MAKEFUN_ENV_URL/register as {"port": N}, long-poll $MAKEFUN_ENV_URL/done until it answers
// {"done": true}, then exit 0. Without MAKEFUN_ENV_URL the same server simply listens on
// $PORT (default 8080) and stays up, which is how the entry is run and tested locally.

import { createApp } from './app.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function registerWithRetry(envUrl: string, port: number): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (response.ok) return;
    } catch {
      // the environment may still be coming up; retry until the deadline
    }
    if (Date.now() > deadline) throw new Error('could not register with the environment');
    await sleep(250);
  }
}

async function waitForDone(envUrl: string): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/done`);
      const data = (await response.json().catch(() => null)) as { done?: unknown } | null;
      if (data !== null && data.done === true) return;
    } catch {
      await sleep(500);
    }
    await sleep(100);
  }
}

async function main(): Promise<void> {
  const server = createApp();
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl !== undefined && envUrl !== '') {
    await new Promise<void>((resolve) => {
      server.listen(0, () => resolve());
    });
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    await registerWithRetry(envUrl, port);
    await waitForDone(envUrl);
    server.close();
    process.exit(0);
  }
  const port = Number(process.env.PORT ?? 8080);
  server.listen(port, () => {
    console.log(`asu-forge listening on ${port}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
    });
  }
}

void main();
