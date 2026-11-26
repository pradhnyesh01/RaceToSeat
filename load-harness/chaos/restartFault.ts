// Postgres-restart Fault (issue #51, C4): a scratch Postgres container the
// run owns end to end, and the Fault that restarts or kills it under load.
//
// Every other Fault in this harness leaves the Postgres *server* up (it kills
// a backend, delays or cuts the link, or kills the app). A restart is the only
// one that takes the server's memory away, so it is the only one that can test
// the assumption the formal model makes and no chaos run could reach: that a
// COMMIT the client has been told about is still there once the server is back
// (`CommittedPersists`, formal/CrashRecovery.tla).
//
// SAFETY. Restarting a database server is the one Fault that would take down
// somebody else's work if it hit the wrong container: the repo's dev Postgres
// (`racetoseat-postgres`) and sibling sessions' containers live on this Docker.
// So this module never accepts a container name from the caller. It creates its
// own (`c4-pg-<hex>`, a free loopback port, a run label), remembers the full
// container id Docker returned, and BEFORE EVERY destructive command re-reads
// that id's name and label and refuses unless both still say "this run's".
// Commands then address the full id, never a name.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { Client } from "pg";

const execFileAsync = promisify(execFile);

export const CONTAINER_NAME_PREFIX = "c4-pg-";
export const RUN_LABEL_KEY = "racetoseat.c4.run";
export const DEFAULT_IMAGE = "postgres:17";

export type RestartVariant = "restart" | "stop" | "kill";

// How the scratch server is configured. `safe` is stock durability (what any
// real deployment runs); `unsafe` is the negative control's configuration: a
// server that acknowledges COMMIT before its WAL has left memory, so a hard
// kill can lose acknowledged commits. It is a different *database
// configuration*, never a toggle in production code (ADR-0023).
export type DurabilityProfile = "safe" | "unsafe";

export function postgresFlags(profile: DurabilityProfile): string[] {
  // Same tuning the repo's dev Postgres carries (docker-compose.yml): the app's
  // pool default is 500, so the server must admit that many.
  const common = ["-c", "deadlock_timeout=100ms", "-c", "max_connections=600"];
  if (profile === "safe") return common;
  return [
    ...common,
    // COMMIT returns before its WAL record is flushed ...
    "-c", "synchronous_commit=off",
    // ... and nothing flushes it for 10 s (the maximum) unless a checkpoint
    // does: the window in which an acknowledged commit exists only in the
    // server's memory. Without these two the default 200 ms window would make
    // the control's outcome a matter of timing.
    "-c", "wal_writer_delay=10000ms",
    "-c", "wal_writer_flush_after=1GB",
    "-c", "checkpoint_timeout=1h",
    // Not what loses the commit here (a process kill leaves the OS's cache
    // intact, so fsync is not on this path; see the exhibit's limitation), but
    // the configuration the brief names as "unsafe", and it costs nothing.
    "-c", "fsync=off",
  ];
}

export interface DockerRunArgsInput {
  containerName: string;
  runTag: string;
  hostPort: number;
  image: string;
  profile: DurabilityProfile;
  user: string;
  password: string;
  database: string;
}

// Pure, so a test can pin exactly what gets created without Docker. The port
// is published on loopback only.
export function dockerRunArgs(input: DockerRunArgsInput): string[] {
  return [
    "run",
    "-d",
    "--name", input.containerName,
    "--label", `${RUN_LABEL_KEY}=${input.runTag}`,
    "-p", `127.0.0.1:${input.hostPort}:5432`,
    "-e", `POSTGRES_USER=${input.user}`,
    "-e", `POSTGRES_PASSWORD=${input.password}`,
    "-e", `POSTGRES_DB=${input.database}`,
    input.image,
    "postgres",
    ...postgresFlags(input.profile),
  ];
}

export interface InspectedIdentity {
  id: string;
  name: string;
  label: string;
}

// The ownership rule, pure: the container Docker reports for our id must carry
// our id, our generated name and our run label. Anything else — a recycled
// name, a different container, a label someone changed — is refused.
export function ownershipProblem(expected: { id: string; name: string; runTag: string }, actual: InspectedIdentity): string | undefined {
  if (!expected.name.startsWith(CONTAINER_NAME_PREFIX)) return `refusing: ${expected.name} does not start with ${CONTAINER_NAME_PREFIX}`;
  if (actual.id !== expected.id) return `container id ${actual.id} is not this run's ${expected.id}`;
  if (actual.name.replace(/^\//, "") !== expected.name) return `container name ${actual.name} is not this run's ${expected.name}`;
  if (actual.label !== expected.runTag) return `container label ${JSON.stringify(actual.label)} is not this run's ${expected.runTag}`;
  return undefined;
}

export async function freeLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (address && typeof address === "object" ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface FaultTimeline {
  variant: RestartVariant;
  profile: DurabilityProfile;
  // ms from the Fault driver's own t0 (the run's clock; see runRestart.ts).
  commandStartedAtMs: number;
  commandReturnedAtMs: number;
  // `kill` only: the pause between the kill and `docker start`.
  heldDownMs: number;
  // First probe that failed, and first probe that succeeded afterwards.
  firstProbeFailedAtMs: number | null;
  dbBackAtMs: number | null;
  // Wall time the server was unreachable, as the probe saw it.
  unreachableMs: number | null;
}

export class ScratchPostgres {
  readonly runTag = randomBytes(4).toString("hex");
  readonly name = `${CONTAINER_NAME_PREFIX}${this.runTag}`;
  readonly user = "chaos";
  readonly password = "chaos";
  readonly database = "chaos";
  id = "";
  hostPort = 0;
  private removed = false;

  constructor(
    readonly profile: DurabilityProfile = "safe",
    private readonly image: string = DEFAULT_IMAGE,
  ) {}

  get url(): string {
    return `postgres://${this.user}:${this.password}@127.0.0.1:${this.hostPort}/${this.database}`;
  }

  private async docker(args: string[], timeoutMs = 120_000): Promise<string> {
    const { stdout } = await execFileAsync("docker", args, { timeout: timeoutMs });
    return stdout.trim();
  }

  async start(): Promise<void> {
    this.hostPort = await freeLoopbackPort();
    this.id = await this.docker(
      dockerRunArgs({
        containerName: this.name,
        runTag: this.runTag,
        hostPort: this.hostPort,
        image: this.image,
        profile: this.profile,
        user: this.user,
        password: this.password,
        database: this.database,
      }),
    );
    await this.waitReady(60_000);
  }

  // The guard. Called before every command that stops, kills, starts or
  // removes anything.
  private async assertOwned(): Promise<void> {
    if (!this.id) throw new Error("ScratchPostgres: no container has been created");
    const out = await this.docker(["inspect", "--format", `{{.Id}}|{{.Name}}|{{index .Config.Labels "${RUN_LABEL_KEY}"}}`, this.id], 15_000);
    const [id = "", name = "", label = ""] = out.split("|");
    const problem = ownershipProblem({ id: this.id, name: this.name, runTag: this.runTag }, { id, name, label });
    if (problem) throw new Error(`ScratchPostgres refuses to act: ${problem}`);
  }

  async stopSignal(): Promise<string> {
    await this.assertOwned();
    return await this.docker(["inspect", "--format", "{{.Config.StopSignal}}", this.id], 15_000);
  }

  // A connection of the harness's own, opened and closed per probe so a dead
  // pooled connection can never be mistaken for "the server is up".
  async probe(timeoutMs = 600): Promise<boolean> {
    const client = new Client({ connectionString: this.url, connectionTimeoutMillis: timeoutMs, application_name: "racetoseat-chaos" });
    client.on("error", () => undefined);
    try {
      await client.connect();
      await client.query("SELECT 1");
      return true;
    } catch {
      return false;
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  async waitReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    // The image's entrypoint starts a throwaway server to run initdb, stops it,
    // then starts the real one; a successful probe in between is a false
    // positive, so require two in a row 500 ms apart.
    let consecutive = 0;
    while (Date.now() < deadline) {
      if (await this.probe(1000)) {
        consecutive += 1;
        if (consecutive >= 2) return;
      } else {
        consecutive = 0;
      }
      await sleep(500);
    }
    throw new Error(`Postgres in ${this.name} not ready within ${timeoutMs}ms`);
  }

  // Applies the Fault. `restart` is `docker restart` (the image's stop signal
  // is SIGINT, Postgres's *fast shutdown*: sessions terminated, in-flight
  // transactions rolled back, a shutdown checkpoint written, then started
  // again). `stop` is the same orderly shutdown (`docker stop`) but, like
  // `kill`, held down for `downMs` before `docker start`: it exists so the two
  // shutdown modes can be compared at an equal outage length. `kill` is
  // `docker kill` (SIGKILL: no shutdown, no checkpoint; the next start replays
  // the WAL) followed, after `downMs`, by `docker start`.
  async applyFault(variant: RestartVariant, downMs: number, clock: () => number): Promise<FaultTimeline> {
    await this.assertOwned();
    let firstProbeFailedAtMs: number | null = null;
    let dbBackAtMs: number | null = null;
    let probing = true;
    const prober = (async () => {
      while (probing) {
        const ok = await this.probe(400);
        const t = clock();
        if (!ok && firstProbeFailedAtMs === null) firstProbeFailedAtMs = t;
        if (ok && firstProbeFailedAtMs !== null && dbBackAtMs === null) {
          dbBackAtMs = t;
          return;
        }
        await sleep(50);
      }
    })();

    const commandStartedAtMs = clock();
    let heldDownMs = 0;
    if (variant === "restart") {
      await this.docker(["restart", "-t", "30", this.id]);
    } else {
      if (variant === "stop") await this.docker(["stop", "-t", "30", this.id]);
      else await this.docker(["kill", "--signal", "KILL", this.id]);
      heldDownMs = downMs;
      await sleep(downMs);
      await this.assertOwned();
      await this.docker(["start", this.id]);
    }
    const commandReturnedAtMs = clock();

    // Wait for the server to answer again (bounded).
    const deadline = Date.now() + 90_000;
    while (dbBackAtMs === null && Date.now() < deadline) await sleep(50);
    probing = false;
    await prober;
    return {
      variant,
      profile: this.profile,
      commandStartedAtMs,
      commandReturnedAtMs,
      heldDownMs,
      firstProbeFailedAtMs,
      dbBackAtMs,
      unreachableMs: firstProbeFailedAtMs !== null && dbBackAtMs !== null ? dbBackAtMs - firstProbeFailedAtMs : null,
    };
  }

  async setting(name: string): Promise<string> {
    const client = new Client({ connectionString: this.url, application_name: "racetoseat-chaos" });
    client.on("error", () => undefined);
    await client.connect();
    try {
      const res = await client.query<{ setting: string }>("SELECT setting FROM pg_settings WHERE name = $1", [name]);
      return res.rows[0]?.setting ?? "?";
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  async remove(): Promise<void> {
    if (this.removed || !this.id) return;
    this.removed = true;
    try {
      await this.assertOwned();
      await this.docker(["rm", "-f", "-v", this.id], 60_000);
    } catch (err) {
      console.error(`Could not remove ${this.name}: ${(err as Error).message}`);
    }
  }
}
