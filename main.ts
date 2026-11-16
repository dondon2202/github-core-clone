// How this process lives and dies inside a trial.
//
// The harness — the "env" — is in charge of the trial: it starts this process,
// waits for it to announce a port, runs the suite against that port, and in
// the end reports that the trial is over. This file is only that handshake.
// It implements no forge behavior at all; the server is built by app.ts, and
// every route it answers is decided there and in the modules app.ts pulls in.
// The sequence here is:
//
//   1. Learn the env's origin from MAKEFUN_ENV_URL. Without an origin there
//      is nobody to announce to, so the process refuses to start.
//   2. Build the server and bind it to a port the kernel picks. The env owns
//      8080, so this process never asks for a fixed port.
//   3. Tell the env the bound port, retrying for as long as that takes: the
//      env may still be coming up when this process starts.
//   4. Ask the env, again and again, whether the trial is finished, and only
//      once it says yes shut the server down and exit successfully.
//
// Both conversations with the env follow one discipline: each attempt gets a
// deadline, failures back off exponentially up to a cap, and the loop never
// ends by itself. Only the env may end the trial. The one exception is a
// contract violation — a 400 or 405 answer to the register call — which fails
// the process at once instead of retrying forever.

import { createApp as buildServer } from './app.ts';

// Refuse to start when no env origin is configured: with nobody to announce
// to, binding a server would be pointless. This never returns.
const failToStart = (): never => {
    process.stderr.write("[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n");
    process.exit(1);
};

// The env's origin, with trailing slashes stripped so the paths joined onto
// it below never gain a double slash.
const resolveEnvOrigin = (): string => {
    const configured = process.env.MAKEFUN_ENV_URL ?? '';
    const origin = configured.replace(/\/+$/, '');
    if (origin.length === 0) failToStart();
    return origin;
};

const envOrigin = resolveEnvOrigin();

// How long one env request may run before it is abandoned and retried.
const ATTEMPT_BUDGET_MS = 30 * 1000;
// The pause after a failed attempt starts here and doubles, up to the cap.
const BACKOFF_START_MS = 250;
const BACKOFF_CAP_MS = 2 * 1000;

const pause = (milliseconds: number): Promise<void> =>
    new Promise((wake) => {
        setTimeout(wake, milliseconds);
    });

// The pause after `failures` failed attempts: the start value doubled once
// per failure, capped. Doubling stops after eight steps; the cap binds first.
const backoffAfter = (failures: number): number => {
    let wait = BACKOFF_START_MS;
    for (let step = 0; step < failures && step < 8; step += 1) {
        wait *= 2;
    }
    return wait < BACKOFF_CAP_MS ? wait : BACKOFF_CAP_MS;
};

// Announce the bound port to the env, retrying until it sticks. A 200 means
// the env recorded this process; a 409 means an earlier register already won,
// which is equally final. A 400 or 405 means the request broke the contract,
// so the process fails at once. Anything else — a dropped connection, a
// timeout, an unexpected status — is read as "the env is not ready yet".
const announcePort = async (port: number): Promise<void> => {
    const payload = JSON.stringify({ port });
    let failures = 0;
    for (;;) {
        try {
            const answer = await fetch(`${envOrigin}/register`, {
                method: "POST",
                body: payload,
                headers: { "content-type": "application/json" },
                signal: AbortSignal.timeout(ATTEMPT_BUDGET_MS),
            });
            const status = answer.status;
            if (status === 200 || status === 409) {
                return;
            }
            if (status === 400 || status === 405) {
                const detail = await answer.text();
                throw new Error(`register answered HTTP ${status}: ${detail}`);
            }
        } catch (problem) {
            if (problem instanceof Error && problem.message.indexOf("register answered HTTP ") === 0) {
                throw problem;
            }
        }
        await pause(backoffAfter(failures));
        failures += 1;
    }
};

// Ask the env whether the trial is over, forever, until it says yes. Every
// failure mode — silence, a timeout, a non-200 status, a body that is not
// JSON or does not say done — means "not yet", never "give up".
const awaitTrialEnd = async (): Promise<void> => {
    let failures = 0;
    for (;;) {
        let finished = false;
        try {
            const answer = await fetch(`${envOrigin}/done`, {
                signal: AbortSignal.timeout(ATTEMPT_BUDGET_MS),
            });
            if (answer.ok) {
                const payload = (await answer.json()) as { done?: unknown };
                finished = payload.done === true;
            }
        } catch {
            finished = false;
        }
        if (finished) {
            return;
        }
        await pause(backoffAfter(failures));
        failures += 1;
    }
};

// Bind the server to an ephemeral port and report the port the kernel chose.
// A listen failure rejects; an address that is not a TCP address is a bug.
const bindEphemeral = async (server: ReturnType<typeof buildServer>): Promise<number> => {
    await new Promise<void>((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(0, () => {
            resolveListen();
        });
    });
    const bound = server.address();
    if (bound === null || typeof bound === "string") throw new Error("the server did not bind an ephemeral TCP port");
    return bound.port;
};

// The whole life of the process: bind, announce, wait for the trial to end,
// then shut the server down.
const boot = async (): Promise<void> => {
    const server = buildServer();
    const port = await bindEphemeral(server);
    process.stdout.write(`[entry] listening on port ${port}\n`);

    await announcePort(port);
    process.stdout.write("[entry] registered; waiting for the env to say done\n");

    await awaitTrialEnd();
    server.close();
    process.stdout.write("[entry] done\n");
};

boot()
    .then(() => {
        process.exit(0);
    })
    .catch((problem: unknown) => {
        const message = problem instanceof Error ? problem.message : String(problem);
        process.stderr.write(`[entry] ${message}\n`);
        process.exit(1);
    });
