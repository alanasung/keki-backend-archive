/**
 * Throwaway Neon branches for local test runs.
 *
 * CI creates a fresh branch per run (`.github/workflows/ci.yml`, the
 * `neondatabase/create-branch-action` step) and that is the only reason its
 * integration suites are reliable: several of them assert on whole-table
 * contents and each assumes it owns the database. Locally those same suites
 * share one persistent branch, so leftover rows from an earlier run — or from
 * the e2e suite, which leaves orders referencing `catalog_items` — make them
 * fail for reasons that have nothing to do with the code under test.
 *
 * This gives local runs the same isolation. `pnpm test:isolated` wraps it.
 *
 * The API key is read from the environment and never written, echoed, or
 * logged. Connection URIs carry the role password, so they are printed only
 * as `KEY=value` lines meant to be consumed by a shell — never inside prose,
 * and never in the sweep/delete paths.
 */
const API = 'https://console.neon.tech/api/v2';

/** Only branches with this prefix are ever deleted. */
const LOCAL_PREFIX = 'local-';

interface Branch {
  readonly id: string;
  readonly name: string;
  readonly default?: boolean;
  readonly protected?: boolean;
  readonly created_at?: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is required. Add it to .env — see docs/environment.md. ` +
        'The API key comes from the Neon console under Account settings → API keys.',
    );
  }
  return value;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const key = requireEnv('NEON_API_KEY');
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    // The body can echo request parameters; it never contains the key, but
    // truncate anyway rather than dumping an unbounded provider response.
    const body = (await response.text()).slice(0, 300);
    throw new Error(`Neon API ${init?.method ?? 'GET'} ${path} failed: ${response.status} ${body}`);
  }
  return (await response.json()) as T;
}

async function listBranches(project: string): Promise<readonly Branch[]> {
  const data = await api<{ branches: Branch[] }>(`/projects/${project}/branches`);
  return data.branches;
}

/**
 * Neon exposes pooled and direct connection URIs for the same branch; the
 * pooled host carries `-pooler`. `packages/database/src/env.ts` rejects the
 * two being swapped, so they are fetched separately rather than derived by
 * string surgery on a hostname.
 */
async function connectionUris(
  project: string,
  branchId: string,
): Promise<{ pooled: string; direct: string }> {
  const fetchUri = async (pooled: boolean): Promise<string> => {
    const params = new URLSearchParams({
      branch_id: branchId,
      database_name: 'neondb',
      role_name: 'neondb_owner',
      pooled: String(pooled),
    });
    const data = await api<{ uri: string }>(`/projects/${project}/connection_uri?${params}`);
    return data.uri;
  };

  const [pooled, direct] = await Promise.all([fetchUri(true), fetchUri(false)]);

  // Belt and braces: if Neon ever changes the pooled host convention, fail
  // loudly here rather than handing @keki/database a swapped pair it will
  // reject later with a less obvious message.
  if (!new URL(pooled).host.includes('-pooler')) {
    throw new Error('Expected the pooled connection URI host to contain "-pooler"; it does not.');
  }
  if (new URL(direct).host.includes('-pooler')) {
    throw new Error('Expected the direct connection URI host NOT to contain "-pooler"; it does.');
  }

  return { pooled, direct };
}

async function create(project: string, parentName: string | undefined): Promise<void> {
  const branches = await listBranches(project);
  const parent = parentName
    ? branches.find((b) => b.name === parentName)
    : branches.find((b) => b.default) ?? branches[0];
  if (parent === undefined) {
    throw new Error(parentName ? `No branch named "${parentName}".` : 'No branches found.');
  }

  // A timestamp rather than a random id so a leaked branch is legible in the
  // console, and so `sweep` can reason about age without an API round trip.
  const name = `${LOCAL_PREFIX}${new Date().toISOString().replace(/[:.]/g, '-')}`;

  const created = await api<{ branch: Branch }>(`/projects/${project}/branches`, {
    method: 'POST',
    body: JSON.stringify({
      branch: { name, parent_id: parent.id },
      endpoints: [{ type: 'read_write' }],
    }),
  });

  const { pooled, direct } = await connectionUris(project, created.branch.id);

  // Consumed by `eval "$(...)"` in test:isolated. Printed as assignments only.
  process.stdout.write(`DATABASE_URL_POOLED='${pooled}'\n`);
  process.stdout.write(`DATABASE_URL_DIRECT='${direct}'\n`);
  process.stdout.write(`KEKI_LOCAL_BRANCH='${created.branch.name}'\n`);
  process.stderr.write(`created ${created.branch.name} from ${parent.name}\n`);
}

async function destroy(project: string, name: string): Promise<void> {
  const branches = await listBranches(project);
  const branch = branches.find((b) => b.name === name);
  if (branch === undefined) {
    process.stderr.write(`no branch named ${name}; nothing to delete\n`);
    return;
  }
  assertDeletable(branch);
  await api(`/projects/${project}/branches/${branch.id}`, { method: 'DELETE' });
  process.stderr.write(`deleted ${branch.name}\n`);
}

/**
 * The guard that keeps this script from being the thing that deletes the
 * real database. Three independent conditions, any one of which refuses.
 */
function assertDeletable(branch: Branch): void {
  if (branch.default === true) {
    throw new Error(`Refusing to delete "${branch.name}": it is the project's default branch.`);
  }
  if (branch.protected === true) {
    throw new Error(`Refusing to delete "${branch.name}": it is protected.`);
  }
  if (!branch.name.startsWith(LOCAL_PREFIX)) {
    throw new Error(
      `Refusing to delete "${branch.name}": only branches prefixed "${LOCAL_PREFIX}" are deletable by this script.`,
    );
  }
}

async function sweep(project: string, maxAgeHours: number): Promise<void> {
  const branches = await listBranches(project);
  const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
  const stale = branches.filter((b) => {
    if (b.default === true || b.protected === true) return false;
    if (!b.name.startsWith(LOCAL_PREFIX)) return false;
    const created = b.created_at ? Date.parse(b.created_at) : Number.NaN;
    return Number.isFinite(created) && created < cutoff;
  });

  if (stale.length === 0) {
    process.stderr.write(`no ${LOCAL_PREFIX}* branches older than ${maxAgeHours}h\n`);
    return;
  }

  for (const branch of stale) {
    assertDeletable(branch);
    await api(`/projects/${project}/branches/${branch.id}`, { method: 'DELETE' });
    process.stderr.write(`swept ${branch.name}\n`);
  }
}

async function list(project: string): Promise<void> {
  const branches = await listBranches(project);
  for (const b of branches) {
    const tags = [b.default ? 'default' : '', b.protected ? 'protected' : ''].filter(Boolean);
    process.stderr.write(`  ${b.name}${tags.length > 0 ? `  (${tags.join(', ')})` : ''}\n`);
  }
}

const [command, argument] = process.argv.slice(2);
const project = requireEnv('NEON_PROJECT_ID');

switch (command) {
  case 'create':
    await create(project, argument);
    break;
  case 'delete':
    if (argument === undefined) throw new Error('Usage: db-branch delete <branch-name>');
    await destroy(project, argument);
    break;
  case 'sweep':
    await sweep(project, argument ? Number(argument) : 6);
    break;
  case 'list':
    await list(project);
    break;
  default:
    process.stderr.write(
      'Usage: tsx scripts/db-branch.ts <create [parent] | delete <name> | sweep [maxAgeHours] | list>\n',
    );
    process.exit(1);
}
