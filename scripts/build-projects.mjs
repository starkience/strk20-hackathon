/* build-projects.mjs - turn registry.json into projects.json.
 *
 * registry.json is the human-edited source: one object per project, added by
 * pull request. This resolves each entry through the GitHub API and writes the
 * flat file the hub at strk20.starknet.io/hackathon fetches at runtime.
 *
 * Each project carries two generated sentences: `summary`, describing what the
 * project is, and `latest_push`, describing what changed in the most recent
 * push. Plus `tooling` - what the repository actually depends on, read from
 * package.json and Scarb.toml rather than claimed.
 *
 * Everything is cached on the repository's head SHA. A project that hasn't
 * pushed since the last run costs exactly one API call and no tokens, which is
 * what makes a 30-minute cron affordable across an 18-day sprint.
 *
 * No dependencies - Node 20's built-in fetch only.
 *
 *   node scripts/build-projects.mjs
 *
 * GITHUB_TOKEN  optional locally (60 requests/hour unauthenticated), provided
 *               automatically in Actions.
 * OPENAI_API_KEY optional - without it the sentences are simply omitted and the
 *               hub falls back to the one-liner the team wrote themselves.
 * OPENAI_MODEL  defaults to gpt-4o-mini.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const API = "https://api.github.com";
const TOKEN = process.env.GITHUB_TOKEN || "";
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "strk20-private-sprint-indexer",
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

const CATEGORIES = ["Consumer", "DeFi", "Tooling", "Infra", "Payments", "Gaming", "Other"];

/* Warnings are collected rather than thrown: one team with a typo in their
 * repo URL must not take the whole hub down. The run reports them at the end
 * and still writes a good projects.json for everyone else. */
const warnings = [];
const warn = (msg) => { warnings.push(msg); console.warn(`  warn: ${msg}`); };

const REGISTRY_URL = new URL("../registry.json", import.meta.url);
const PROJECTS_URL = new URL("../projects.json", import.meta.url);
const AFFILIATIONS_URL = new URL("../affiliations.json", import.meta.url);

/* Who is building from inside the ecosystem rather than entering it. A row from
 * StarkWare or the Foundation reads differently from a stranger's, and a reader
 * comparing projects deserves to know which is which without recognising
 * handles.
 *
 * Declared here rather than in a registry entry, for the same reason the star
 * is not read from one: a team may edit its own row, so anything kept there is
 * something a project can claim about itself. The registrations bot only
 * applies pull requests whose sole file is registry.json.
 *
 *   { "starkware": ["handle"], "foundation": ["handle"] }
 */
function loadAffiliations() {
  const out = new Map();
  if (!existsSync(AFFILIATIONS_URL)) return out;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(AFFILIATIONS_URL, "utf8"));
  } catch (e) {
    warn(`affiliations.json is not valid JSON (${e.message}) - nobody is badged this run`);
    return out;
  }
  for (const [org, logins] of Object.entries(parsed || {})) {
    if (!Array.isArray(logins)) continue;
    /* Lowercased: GitHub handles are case-insensitive and a maintainer typing
       one from memory should not silently badge nobody. */
    for (const login of logins) {
      if (typeof login === "string" && login.trim()) out.set(login.trim().toLowerCase(), org);
    }
  }
  return out;
}

/* ---------- GitHub ---------- */

async function gh(path) {
  /* A dropped connection is not a reason to lose the whole run. Sixty projects
   * make several hundred requests a run and one of them will eventually fail
   * on the socket rather than the status - "other side closed" took an entire
   * index down after every project had already been resolved.
   *
   * Retried twice with a short backoff, then treated as no answer, which every
   * caller already handles. Rate limiting still throws: that is a real stop,
   * and retrying into it would only make it worse. */
  let res = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetch(`${API}${path}`, { headers: HEADERS });
      break;
    } catch (e) {
      if (attempt === 2) {
        warn(`${path} failed to connect (${e.cause?.message || e.message}) - skipped`);
        return null;
      }
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  if (!res) return null;
  if (res.status === 403 || res.status === 429) {
    const reset = res.headers.get("x-ratelimit-reset");
    throw new Error(`rate limited on ${path}` + (reset ? ` (resets ${new Date(reset * 1000).toISOString()})` : ""));
  }
  if (!res.ok) return null;
  /* An empty body is a valid answer, not a broken one: /contributors replies
     204 No Content for a repository with no commits yet, and res.json() on
     that throws "Unexpected end of JSON input" - which took down a whole
     index run over one repository registered before its first push. */
  if (res.status === 204) return null;
  const body = await res.text();
  if (!body.trim()) return null;
  try {
    return JSON.parse(body);
  } catch {
    warn(`${path} returned a body that is not JSON`);
    return null;
  }
}

/* Accepts the shapes people actually paste: with or without a trailing slash,
 * with or without .git, and full URLs with query strings. */
function parseRepo(url) {
  if (typeof url !== "string") return null;
  const m = url.trim().match(/github\.com[/:]([^/]+)\/([^/?#]+)/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/i, "") };
}

async function getTextFile(owner, repo, path) {
  const f = await gh(`/repos/${owner}/${repo}/contents/${path}`);
  if (!f || !f.content) return null;
  try {
    return Buffer.from(f.content, f.encoding || "base64").toString("utf8");
  } catch { return null; }
}

const userCache = new Map();
async function resolveUser(login) {
  if (userCache.has(login)) return userCache.get(login);
  const u = await gh(`/users/${encodeURIComponent(login)}`);
  /* An unresolvable handle still renders - GitHub's identicon endpoint gives a
   * stable placeholder, so a typo shows a grey avatar instead of a broken image. */
  const out = u
    ? { login: u.login, name: u.name || u.login, avatar_url: u.avatar_url }
    : { login, name: login, avatar_url: `https://github.com/${encodeURIComponent(login)}.png` };
  if (!u) warn(`unknown GitHub user "${login}"`);
  userCache.set(login, out);
  return out;
}

/* ---------- builders ---------- */

const SPRINT_START = "2026-08-14T00:00:00Z";

/* Who actually wrote the code, taken from the commit history rather than from
 * a list someone remembered to keep current. A teammate who joins in week two
 * shows up the moment they push.
 *
 * Two lists, for two different questions. The sprint window says who is active
 * now, and the activity strip and the ordering come from it. Everyone who has
 * ever committed says who the team is, and that is what gets named - scoping
 * the credits to the window meant a teammate whose work predates day one was
 * missing from their own project, which is how most repositories look on the
 * morning the sprint opens.
 *
 * Avatars and names come straight off the commit payload, so this costs one
 * request per project rather than one per person. */
/* Coding agents sign their work in a Co-Authored-By trailer, or commit under
 * their own app account. Both are worth surfacing: building with an agent is
 * encouraged here, so the agent is a participant rather than something to
 * filter out. Matched against known identities only - an unrecognised
 * co-author is far more likely to be a person than a tool. */
const AGENTS = [
  [/claude|anthropic/i, "Claude"],
  [/copilot/i, "GitHub Copilot"],
  [/\bcodex\b|openai/i, "Codex"],
  [/cursor/i, "Cursor"],
  [/^claude$/i, "Claude"],
  [/devin/i, "Devin"],
  [/\bjules\b/i, "Jules"],
  [/windsurf|codeium/i, "Windsurf"],
  [/\baider\b/i, "Aider"],
];

/* The trailer carries the model that actually did the work - "Claude Opus 5",
 * "GPT-5 Codex" - so keep it rather than flattening to a family name. The
 * family is only used to pick the avatar. */
const agentFamily = (text) => {
  for (const [re, name] of AGENTS) if (re.test(text)) return name;
  return null;
};

const cleanAgentName = (raw) => raw
  .replace(/<[^>]*>/g, "")        // the email in a Co-Authored-By line
  .replace(/\([^)]*\)/g, "")      // parenthetical notes like "(1M context)"
  .replace(/\s+/g, " ")
  .trim();

async function detectBuilders(owner, repo, entry, meta) {
  const seen = new Map();
  const counts = new Map();
  const agents = new Map();
  /* Which sprint days this repository was worked on. Collected here because
     the commit list is already in hand for the builders - the strip costs no
     extra requests. */
  const days = new Set();

  /* Keyed on family so the two ways an agent shows up merge into one entry:
     the account that commits (which carries the avatar) and the Co-Authored-By
     trailer (which carries the model). Name prefers the trailer, since
     "Claude Opus 5" says more than the account's "Claude". */
  const noteAgent = (display, family, avatar) => {
    const prev = agents.get(family) || { family, commits: 0 };
    agents.set(family, {
      family,
      name: display || prev.name || family,
      avatar_url: avatar || prev.avatar_url || "",
      commits: prev.commits + 1,
    });
  };

  const collect = (commits) => {
    for (const c of commits || []) {
      const a = c.author;
      const msg = c.commit?.message || "";

      /* Committer date, not author date: a rebase or a cherry-pick keeps the
         author date from whenever the work was first written, which would
         credit a day the repository saw nothing. UTC throughout, so a team is
         not handed an extra dot by its own timezone. */
      const when = c.commit?.committer?.date || c.commit?.author?.date;
      if (when) {
        const d = new Date(when);
        if (!isNaN(d)) days.add(d.toISOString().slice(0, 10));
      }

      /* Co-authors never appear in the author field - GitHub puts only the
         primary author there - so the trailer is the only place to read them. */
      for (const line of msg.split("\n")) {
        const m = line.match(/^\s*Co-Authored-By:\s*(.+)$/i);
        if (m) {
          const family = agentFamily(m[1]);
          if (family) noteAgent(cleanAgentName(m[1]), family, null);
        }
      }

      if (!a?.login) continue;

      /* Agents that commit as themselves show up as ordinary contributors -
         github.com/claude and github.com/cursoragent are both User accounts -
         so they are recognised by login before the human path. */
      const loginFamily = agentFamily(a.login);
      if (loginFamily) {
        noteAgent(null, loginFamily, a.avatar_url);
        continue;
      }

      if (a.type === "Bot" || /\[bot\]$/i.test(a.login)) continue;
      counts.set(a.login, (counts.get(a.login) || 0) + 1);
      if (!seen.has(a.login)) {
        seen.set(a.login, {
          login: a.login,
          name: c.commit?.author?.name || a.login,
          avatar_url: a.avatar_url,
        });
      }
    }
  };

  const started = Date.now() >= new Date(SPRINT_START).getTime();
  const sprintCommits = await gh(`/repos/${owner}/${repo}/commits?per_page=100${started ? `&since=${SPRINT_START}` : ""}`);
  collect(sprintCommits);

  /* What the sprint has cost this project so far, as opposed to what the last
     push cost - the shareable card wants a total, and additions/deletions on a
     project are per-push. The oldest commit in the window gives its own parent
     for free, which is the pre-sprint state to compare against. */
  const sprintPushes = Array.isArray(sprintCommits) ? sprintCommits.length : 0;
  const oldest = Array.isArray(sprintCommits) && sprintCommits.length
    ? sprintCommits[sprintCommits.length - 1]
    : null;
  /* A repository created during the sprint has no pre-sprint parent to compare
     against - which is most of them here. Then the first commit is the base and
     its own contents count too, so it is asked for separately. */
  const sprintBase = oldest?.parents?.[0]?.sha || oldest?.sha || null;
  const sprintRootCommit = oldest?.parents?.length ? null : (oldest?.sha || null);
  if (!seen.size && started) {
    /* Registered but nothing pushed inside the window yet. */
    collect(await gh(`/repos/${owner}/${repo}/commits?per_page=30`));
  }

  /* The window above decides who is *active*, and it has to, or the activity
   * strip would count work done before anyone entered. It is the wrong list to
   * credit a team by: most projects start before the sprint opens, so a
   * teammate whose commits predate day one disappeared from their own project.
   * Erebus showed one builder against a repository with two contributors.
   *
   * So everyone who has ever committed is named, ordered by what they have
   * done during the sprint. One request, and it carries the avatar. */
  /* A fork carries the upstream's whole contributor list. Forking the starter
     kit is a normal way to begin here, and it put the starter kit's authors on
     a team they have never worked with - raj921's row credited Akashneelesh and
     PhilippeR26, who wrote the thing it was forked from.
   *
   * So anyone the parent already had is dropped, unless they also pushed inside
   * the sprint window - which is the case where they really did join in. */
  const inherited = new Set();
  if (meta?.fork && meta?.parent?.full_name) {
    for (const c of (await gh(`/repos/${meta.parent.full_name}/contributors?per_page=100`)) || []) {
      if (c?.login) inherited.add(c.login.toLowerCase());
    }
  }

  const lifetime = new Map();
  for (const c of (await gh(`/repos/${owner}/${repo}/contributors?per_page=100`)) || []) {
    if (!c?.login) continue;
    if (inherited.has(c.login.toLowerCase()) && !seen.has(c.login)) continue;
    if (c.type === "Bot" || /\[bot\]$/i.test(c.login)) continue;
    const family = agentFamily(c.login);
    if (family) {
      noteAgent(null, family, c.avatar_url);
      continue;
    }
    lifetime.set(c.login, c.contributions || 0);
    if (!seen.has(c.login)) {
      seen.set(c.login, { login: c.login, name: c.login, avatar_url: c.avatar_url });
    }
  }

  /* Most commits this sprint first, so the row's visible faces are the people
     carrying the project now, with everyone else behind them by weight. */
  const detected = [...seen.values()].sort((a, b) =>
    (counts.get(b.login) || 0) - (counts.get(a.login) || 0) ||
    (lifetime.get(b.login) || 0) - (lifetime.get(a.login) || 0));

  /* Anyone the team listed by hand and detection missed: a different commit
     email, a co-author, someone who hasn't pushed yet.
     Matched without case, because GitHub handles are case-insensitive and the
     two sources disagree about capitals: chaoskeyplus-appbuild declared
     "doodabug" while the commits carry "Doodabug", and the row listed them
     twice. */
  const already = new Set([...detected, ...agents.values()].map((b) => (b.login || "").toLowerCase()));
  const declared = Array.isArray(entry.team) ? entry.team : [];
  for (const login of declared) {
    if (typeof login !== "string" || already.has(login.toLowerCase())) continue;
    const user = await resolveUser(login);
    /* resolveUser answers with GitHub's own spelling, which may differ again
       from the one that was typed. */
    if (already.has((user.login || "").toLowerCase())) continue;
    already.add((user.login || "").toLowerCase());
    detected.push(user);
  }

  /* A project whose every commit is signed by an agent has no human in its
     history at all - envelope is written entirely by the claude account. The
     person who owns the repository entered it and is answerable for it, so
     they are the builder until someone else pushes. Organisations are skipped:
     an org is not a person to credit. */
  if (!detected.length) {
    const account = await gh(`/users/${encodeURIComponent(owner)}`);
    if (account?.type === "User" && !agentFamily(owner)) detected.push(await resolveUser(owner));
  }

  /* One row per person, whatever route they arrived by - sprint commits,
     lifetime contributors, the declared team, or the owner fallback. Cheaper to
     guarantee here than to reason about four sources agreeing on capitals. */
  const unique = [];
  const emitted = new Set();
  for (const b of detected) {
    const key = (b.login || "").toLowerCase();
    if (!key || emitted.has(key)) continue;
    emitted.add(key);
    unique.push(b);
  }

  return {
    builders: unique,
    sprint_pushes: sprintPushes,
    sprint_base: sprintBase,
    sprint_root: sprintRootCommit,
    agents: [...agents.values()].sort((x, y) => y.commits - x.commits),
    /* Sprint days only. The fallback query above reaches outside the window to
       find faces for a repository that has not pushed yet, and those commits
       must not light dots. */
    active_days: [...days].filter((d) => d >= SPRINT_START.slice(0, 10)).sort(),
  };
}

/* ---------- stack detection ---------- */

/* Two passes. Dependencies are the strong signal - a package.json entry means
 * the code actually imports it. Text is the weak signal, needed because parts
 * of the Starknet privacy stack have no package to depend on yet (the Wallet
 * API is a wallet method, sub-accounts aren't shipped, privacy_invoke is a
 * Cairo entrypoint). The chip says "detected", not "verified", for that reason.
 *
 * `live` marks the Starknet and STRK20 stack - those are highlighted on the
 * hub. Frameworks show up muted, because "uses React" is not interesting here.
 * The list tracks the routes documented at strk20-by-example.org. */
/* Which parts of the STRK20 stack a project is actually built on.
 *
 * The third field is `stack`: true means it is a piece of STRK20 and earns a
 * pill on the row; false means it is ordinary Starknet or web tooling, real but
 * not what this page is about, so it stays in the project panel.
 *
 * Everything here comes from a manifest - a declared dependency is a fact.
 * Nothing is inferred from prose; see TEXT_SIGNALS. */
const DEP_SIGNALS = [
  /* -sdk, not the bare prefix: @starkware-libs/starknet-privacy-bridge is a
     different package and was lighting the SDK pill. */
  [/@starkware-libs\/starknet-privacy-sdk/, "Privacy SDK", true],
  [/(^|\/)starknet-start$/, "starknet-start", true],
  [/@avnu\/|avnu-sdk/, "AVNU", true],
  [/ekubo/i, "Ekubo", true],
  [/vesu/i, "Vesu", true],
  [/get-starknet/, "get-starknet", false],
  [/^starknet$|starknet\.js/, "starknet.js", false],
  [/starknetkit/i, "Starknetkit", false],
  [/^@?next$/, "Next.js", false],
  [/^react$/, "React", false],
  [/^vite$/, "Vite", false],
  [/^svelte$/, "Svelte", false],
  [/^typescript$/, "TypeScript", false],
];

/* Prose, so nothing here may claim a piece of the STRK20 stack.
 *
 * These run over the README and the manifests, and a README says what a team
 * means to do. "We plan to build an anonymizer" matched /anonymizer/i and lit
 * the same pill as a team that had shipped one; "shielded" matches essentially
 * every STRK20 README ever written. Those signals are gone rather than
 * downgraded - a pill on a public page is a claim we are making on the team's
 * behalf, and this is the whole reason the stack pills are manifest-only.
 *
 * What is left is ordinary tooling, where a false positive costs nothing. */
const TEXT_SIGNALS = [
  [/snforge|starknet-foundry/i, "Starknet Foundry", false],
];

/* Just the [dependencies] and [dev-dependencies] tables of a Scarb.toml.
 * Scoped so a package named "privacy" - or the word in a comment further down
 * the file - cannot be mistaken for depending on the pool's Cairo. */
function scarbDependencies(scarb) {
  const out = [];
  let inDeps = false;
  for (const line of scarb.split("\n")) {
    const header = line.match(/^\s*\[([^\]]+)\]/);
    if (header) { inDeps = /^(dev-)?dependencies$/.test(header[1].trim()); continue; }
    if (inDeps) out.push(line);
  }
  return out.join("\n");
}

async function detectTooling(owner, repo, readme, langs) {
  const found = new Map();
  const add = (label, stack) => { if (!found.has(label)) found.set(label, { label, live: stack, stack }); };

  const pkgRaw = await getTextFile(owner, repo, "package.json");
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw);
      const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
      for (const dep of deps) {
        for (const [re, label, stack] of DEP_SIGNALS) if (re.test(dep)) add(label, stack);
      }
    } catch { warn(`${owner}/${repo} has an unparseable package.json`); }
  }

  const scarb = await getTextFile(owner, repo, "Scarb.toml");
  if (scarb) {
    add("Cairo", false);
    /* An anonymizer is a Cairo contract the pool calls through privacy_invoke,
     * and to compile one you need the pool's own objects - the reference
     * packages both declare `privacy = { path = "../privacy" }`, and a team
     * outside the monorepo reaches the same package over git. Either way the
     * dependency is what gives it away, and nobody adds it by accident.
     *
     * One pill whether they shipped one anonymizer or four: the interesting
     * fact is that they wrote Cairo the pool calls, not how many. Teams that
     * vendor the interface instead of depending on it are missed until the
     * source scan lands, which reads for `fn privacy_invoke` directly. */
    if (/^\s*privacy\s*=/m.test(scarbDependencies(scarb))) add("Anonymizer contract", true);
  }

  if (langs) {
    if (langs.Cairo) add("Cairo", false);
    if (langs.Rust) add("Rust", false);
  }

  /* Text pass over whatever prose and config we already fetched - no extra
   * requests. Scoped to the README and the manifests so a stray mention deep
   * in a lockfile doesn't light up a chip. */
  const corpus = [readme || "", pkgRaw || "", scarb || ""].join("\n");
  for (const [re, label, live] of TEXT_SIGNALS) if (re.test(corpus)) add(label, live);

  return found;
}

/* ---------- the team's own manifest ---------- */

/* strk20.json at the root of a team's repository. Everything a team controls
 * lives here rather than in registry.json, so they never open a second pull
 * request against us - they edit a file in their own repo and the hub picks it
 * up on the next run.
 *
 * registry.json still owns identity (slug, name, category, team), because that
 * is what review is for. This owns everything else. */
async function readManifest(owner, repo) {
  const raw = await getTextFile(owner, repo, "strk20.json");
  if (!raw) return null;
  try {
    const m = JSON.parse(raw);
    return typeof m === "object" && m !== null ? m : null;
  } catch {
    warn(`${owner}/${repo} has a strk20.json that isn't valid JSON - ignoring it`);
    return null;
  }
}

/* ---------- deployed demos ---------- */

/* Teams shouldn't have to open a second pull request the day their site goes
 * live, so the demo is discovered rather than declared. Ordered by how much
 * the signal means: an explicit value is a deliberate choice and always wins,
 * Pages and the Website field are the team saying "this is the site", and a
 * deployment URL is the host saying it. Stops at the first hit, so the extra
 * requests only happen for projects that haven't shipped one yet. */
async function resolveDemo(entry, meta, owner, repo) {
  if (entry.demo_url) return entry.demo_url;

  /* Free - the repository metadata is already in hand. */
  if (meta?.homepage && /^https?:\/\//i.test(meta.homepage)) return meta.homepage;

  if (meta?.has_pages) {
    const pages = await gh(`/repos/${owner}/${repo}/pages`);
    if (pages?.html_url) return pages.html_url;
  }

  const deployments = await gh(`/repos/${owner}/${repo}/deployments?per_page=1`);
  const id = deployments?.[0]?.id;
  if (id) {
    const statuses = await gh(`/repos/${owner}/${repo}/deployments/${id}/statuses?per_page=5`);
    const live = (statuses || []).find((st) => st.state === "success" && st.environment_url);
    if (live) return live.environment_url;
  }

  return "";
}

/* ---------- mainnet transactions ---------- */

const POOL_ADDRESS = "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a";
const MIN_MAINNET_TXS = 3;

/* Addresses come back from different tools with different leading-zero
 * padding, so compare them as numbers. */
const sameAddress = (a, b) => {
  try { return BigInt(a) === BigInt(b); } catch { return false; }
};

async function rpc(url, method, params) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!res.ok) return null;
    return (await res.json()).result || null;
  } catch { return null; }
}

/* A transaction hash proves three things a declared address cannot: the
 * transaction is real, it succeeded, and it actually touched the pool. Private
 * transactions are submitted by relayers, so the sender is never the team -
 * which is exactly why an address was the wrong thing to ask for.
 *
 * Verified against the receipt: execution status, and whether any event in it
 * came from the pool contract. */
/* A transaction counts when it succeeded, touched the pool, and involved this
 * project's own deployed code.
 *
 * The last condition is the one that matters. Touching the pool only proves
 * somebody used STRK20 - any shield or unshield on mainnet does that, including
 * another team's, so three hashes copied from an explorer would have passed.
 * Requiring an event from an address the project itself declared ties the
 * transaction to the repository whose row it is about to light up.
 *
 * A project that deploys nothing is judged on the pool alone: the sprint's
 * privacy-wallet route is a real way to build, and there is no contract of
 * their own to point at. That is recorded on the transaction rather than
 * hidden, so the distinction stays visible. */
async function verifyTransactions(entry, contracts) {
  const declared = Array.isArray(entry.transactions) ? entry.transactions : [];
  const own = contracts.map((c) => c.address).filter(Boolean);
  const out = [];
  for (const raw of declared.slice(0, 10)) {
    const hash = typeof raw === "string" ? raw.trim() : "";
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(hash)) {
      warn(`${entry.slug}: "${hash}" is not a transaction hash`);
      continue;
    }
    const receipt = await rpc(RPCS[0][1], "starknet_getTransactionReceipt", [hash]);
    if (!receipt) {
      out.push({ hash, ok: false, pool: false, mine: false, note: "not found on mainnet" });
      continue;
    }
    const events = receipt.events || [];
    const ok = receipt.execution_status === "SUCCEEDED";
    const pool = events.some((e) => sameAddress(e.from_address, POOL_ADDRESS));

    /* Two ways a transaction can belong to a project, because one alone is
     * wrong in a common case. Events catch a contract that logs; calldata
     * catches one that does not - a contract whose job is to forward a call to
     * the pool may emit nothing at all, and judging it on events would fail a
     * transaction that genuinely ran through it.
     *
     * Scanning the whole calldata rather than parsing the call array: the
     * layout differs across invoke versions, an address appearing anywhere in
     * it means the transaction referred to that contract, and this only has to
     * separate a project's own transactions from a stranger's. */
    let mine = null;
    if (own.length) {
      mine = events.some((e) => own.some((a) => sameAddress(e.from_address, a)));
      if (!mine) {
        const tx = await rpc(RPCS[0][1], "starknet_getTransactionByHash", [hash]);
        const calldata = Array.isArray(tx?.calldata) ? tx.calldata : [];
        mine = calldata.some((felt) => own.some((a) => sameAddress(felt, a)));
      }
    }

    if (!ok) out.push({ hash, ok: false, pool, mine, note: "reverted" });
    else if (!pool) out.push({ hash, ok: true, pool: false, mine, note: "did not touch the pool" });
    else if (mine === false) out.push({ hash, ok: true, pool: true, mine: false, note: "touched the pool, but not through this project's contracts" });
    else out.push({ hash, ok: true, pool: true, mine });
  }
  return out;
}

/* ---------- deployed contracts ---------- */

/* Which network a declared contract actually lives on, asked of the chains
 * rather than taken on trust. Mainnet is checked first because that is what
 * the sprint requires; a contract only on Sepolia is still worth showing, and
 * an address that exists nowhere is reported as such instead of silently
 * rendering a dead explorer link. */
const RPCS = [
  ["mainnet", process.env.MAINNET_RPC_URL || "https://rpc.starknet.lava.build"],
  ["sepolia", process.env.SEPOLIA_RPC_URL || "https://api.cartridge.gg/x/starknet/sepolia"],
];

async function classHashAt(url, address) {
  return rpc(url, "starknet_getClassHashAt", ["latest", address]);
}

async function resolveContracts(entry) {
  const declared = Array.isArray(entry.contracts) ? entry.contracts : [];
  const out = [];
  for (const raw of declared) {
    const address = typeof raw === "string" ? raw : raw.address;
    if (!address || !/^0x[0-9a-fA-F]+$/.test(address)) {
      warn(`${entry.slug} declared an address that isn't a felt: ${address}`);
      continue;
    }
    let network = "unknown";
    for (const [name, rpc] of RPCS) {
      if (await classHashAt(rpc, address)) { network = name; break; }
    }
    if (network === "unknown") warn(`${entry.slug}: ${address.slice(0, 12)}… not found on mainnet or sepolia`);
    out.push({ address, network });
  }
  return out;
}

/* ---------- generated sentences ---------- */

async function openai(system, user, maxTokens = 300) {
  if (!OPENAI_KEY) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        response_format: { type: "json_object" },
        max_completion_tokens: maxTokens,
      }),
    });
    if (!res.ok) { warn(`OpenAI ${res.status} - sentences skipped for this project`); return null; }
    const json = await res.json();
    const text = json.choices?.[0]?.message?.content;
    return text ? JSON.parse(text) : null;
  } catch (e) {
    warn(`OpenAI call failed (${e.message}) - sentences skipped`);
    return null;
  }
}

/* ---------- the star ---------- */

/* Off. The mark is not on the board at the moment, so there is no reason to ask
   a model about sixty-three repositories every time one of them pushes.
   Everything below stays as it was - the rubric, the depth floor, the
   stickiness - and flipping this back on resumes it. Assessments already
   written are kept in projects.json rather than dropped, so turning it on does
   not start from nothing. */
const STAR_ENABLED = false;

/* Two criteria, both judgements only a reader of the code can make: is the idea
 * unusual, and is there real engineering under it.
 *
 * A model is not a measurement. Two things keep it honest enough to hang a
 * public mark on:
 *
 *   - It is anchored. The prompt carries the contracts, the languages and the
 *     dependencies this script already read, so "technically complex" is a
 *     reading of what is there rather than of how the README sells it.
 *   - It is cached on head_sha, like the summaries. A project that has not
 *     pushed is not re-judged, so a star cannot flicker on and off between two
 *     runs of a thirty-minute cron over identical code.
 *
 * What it cannot do is know prior art. There is no web access here, so
 * "has this been done before" is answered from the model's own priors - stated
 * plainly because it is the weakest part of the star, and the reason the
 * rubric asks for novelty *of approach* over novelty of idea. */
const STAR_SYSTEM = `You assess projects in a Starknet privacy hackathon for a public board other builders read.

Return JSON: {"innovative": boolean, "complex": boolean, "why_innovative": string, "why_complex": string, "reason": string}.

innovative - true only if the project applies privacy technology in a way that is not the obvious one. These are the obvious ones and are all false: a private transfer or send-receive app, a tipping jar, a donation page, a payment app whose only idea is that the payment is private, a wallet wrapper, a swap routed through a pool, a balance or portfolio viewer. Wrapping an ordinary product in privacy is not innovation - the question is whether privacy makes something possible that was not possible without it. Applying it to a domain that does not usually get privacy, or composing primitives into something the pool was not built for, is true.

complex - true only if the code shows real engineering depth. Judge the CONTRACTS AND STACK given below, not the README's ambitions. A frontend calling an SDK, or a single contract that wraps a pool call, is false. Cairo of its own that does something, several interacting contracts, a custom proving or nullifier scheme, or an indexer is true.

You are judging work in progress, halfway through a sprint. Depth of what has been built so far, not whether it is finished: an unfinished project with real Cairo behind it is complex, and a polished frontend with nothing underneath is not. Missing demos, videos or mainnet transactions are not your concern.

Be sparing. Answering true to both should mean something. A project you are unsure about is false.

why_innovative - ONE sentence, under 110 characters. State the fact that supports it: what this project does, in what domain, with what mechanism. Facts only, taken from the README and the stack above. Every project here is built on STRK20, so never offer that as the answer - "applies privacy to X" is only worth writing when X is the surprising part. No adjectives: "novel", "unique", "innovative", "sophisticated", "cutting-edge", and no sentence that would still be true of a different project. Also banned: utilizes, leverages, employs, enables, seeks to, thereby, inherent in. Write what it is, not how good it is. If innovative is false, state the fact that makes it the obvious version.

why_complex - ONE sentence, under 110 characters. Name the actual engineering: the contracts by name, what the Cairo does, the scheme or algorithm implemented. Facts only, and only ones visible in the contracts and stack above - never infer from the README's claims. No adjectives about quality. If complex is false, state what is absent.

reason - ONE sentence, under 120 characters, the single line worth showing if only one fits. No praise, no adjectives about the team. Never mention this rubric.`;

/* The star marks a builder, not a submission.
 *
 * It used to require a live demo, a demo video and three verified mainnet
 * transactions on top of the judgement, which made it a completeness badge:
 * nobody held one halfway through a sprint, and the people worth pointing at
 * were invisible for the fortnight it mattered. Those three facts are already
 * on every project panel and drive the submitted state - they did not need a
 * second display, and they were keeping good work off the board.
 *
 * What is left is the part that actually says something about the builder:
 * is the idea unusual, and is there real engineering under it.
 *
 * Sticky, because a model asked twice about nearly the same repository will not
 * always answer the same way, and taking a star back over a typo fix is not
 * something to do to a team mid-sprint. */
/* One thing the model does not get a vote on. Asked whether a project is
 * technically complex it answers generously: stk402 was starred with the reason
 * "lacks published deployed contracts", and strk20-sentinel with no Cairo and
 * nothing deployed. A private payment scheme with no on-chain code of its own
 * is the exact thing this mark exists to filter out.
 *
 * So depth has to be visible before the judgement counts: Cairo in the
 * repository, or a contract actually deployed. Both are read from the repo and
 * the chain, not from the README, and neither is a matter of opinion.
 *
 * The floor applies to a star already given, unlike the sticky judgement.
 * Stickiness is there to absorb a model changing its mind; it is not there to
 * keep a star that should not have been given. */
/* What the floor actually saw, in words, per project - "3 contracts deployed on
   mainnet", "Cairo in the repository". The card that explains a star should
   show the evidence rather than assert that evidence exists. */
function depthEvidence(contracts, tooling) {
  const list = typeof tooling?.values === "function" ? [...tooling.values()] : (tooling || []);
  const cairo = list.some((t) => /^cairo$/i.test(t?.label || ""));
  const deployed = (contracts || []).filter((c) => c.network === "mainnet").length;
  const anywhere = (contracts || []).length;
  const parts = [];
  if (deployed) parts.push(`${deployed} contract${deployed === 1 ? "" : "s"} deployed on mainnet`);
  else if (anywhere) parts.push(`${anywhere} contract${anywhere === 1 ? "" : "s"} deployed`);
  if (cairo) parts.push("Cairo in the repository");
  return parts.join(", ");
}

function hasDepth(contracts, tooling) {
  /* A Map while a project is being rebuilt, a plain array when it comes back
     off the cache. */
  const list = typeof tooling?.values === "function" ? [...tooling.values()] : (tooling || []);
  const cairo = list.some((t) => /^cairo$/i.test(t?.label || ""));
  return cairo || (contracts?.length || 0) > 0;
}

function starOf(assessment, depth, wasStarred) {
  if (!STAR_ENABLED) return false;
  if (!depth) return false;
  return !!(assessment?.innovative && assessment?.complex) || !!wasStarred;
}

const DESC_SYSTEM = `You describe developer projects for a public hackathon board that other builders read.
Return JSON: {"summary": string, "description_long": string}.

EVERY project on this board is built on STRK20, the Starknet privacy pool. That is the entry requirement, not an achievement. Never write that a project "utilizes the STRK20 Privacy Pool", "leverages privacy technology", or "addresses privacy concerns inherent in public blockchains" - it is true of all sixty of them and tells a reader nothing. Name STRK20 only where the specific thing being said would be wrong without it.

summary: ONE sentence, under 110 characters, saying what someone can do with it. Start with a verb or a noun phrase, never with the project's name or "This project".

description_long: two or three sentences. What it does, then how it is built - the contracts, the scheme, the actual pieces. Facts a reader could check by opening the repository.

Write the way an engineer describes their own work to another engineer: flatly. Prefer the short word. "Sends" not "facilitates the transmission of". "Encrypts messages" not "employs client-side encryption to ensure confidentiality".

BANNED - never use any of them: utilizes, leverages, employs, facilitates, empowers, enables (say what it does instead), seeks to, aims to, designed to, provides, incorporates, offers, robust, seamless, cutting-edge, revolutionary, innovative, novel, sophisticated, comprehensive, solution, ecosystem, platform, architecture, "its architecture includes", "components like", "thus", "thereby", "inherent in", "in the realm of", "addressing concerns", exclamation marks.

Do not say a project "provides a platform for" doing something. It does the thing. Do not introduce a list with "its architecture includes components like" - name the parts.

Never use an em dash. Use a comma, a colon, or two sentences instead. If the README is empty or says nothing, return empty strings.

Bad: "This project utilizes the STRK20 Privacy Pool for metadata-resistant communication, employing client-side encryption with ECDH key agreements, thus addressing privacy concerns inherent in public blockchain communications."
Good: "Encrypted messaging with a payment attached to the message. Keys are agreed with ECDH in the browser, and the note spend and the message go on chain in one transaction."`;

/* Checked in code after the call, because the prompt alone did not hold. */
const BANNED_WORDS = ["utilizes", "utilize", "leverages", "leverage", "employs", "facilitates",
  "empowers", "seeks to", "aims to", "provides", "incorporates", "offers", "robust", "seamless",
  "cutting-edge", "revolutionary", "sophisticated", "comprehensive", "platform", "architecture",
  "thereby", "inherent"];

const PUSH_SYSTEM = `You summarise what a developer just pushed, for a live hackathon board.
Return JSON: {"latest_push": string}.
ONE sentence, under 90 characters, past tense, concrete, describing the substance of the change.
Say what changed, not how many commits. Name the actual thing: a feature, a file, a fix, a contract.
BANNED words and phrases - never use any of them: "various", "updates", "improvements", "enhanced", "enhancements", "new features", "and more", "several changes", "refactored code", "better".
If the commits are genuinely trivial (formatting, lockfiles, merges), say so plainly: "Formatting and dependency bumps only."
Never use an em dash.
Good: "Added the useShieldedBalance hook and its tests." Bad: "Enhanced privacy with new features and tests."`;

/* ---------- assembly ---------- */

function validate(entry, index, seenSlugs) {
  const where = `registry.json[${index}]`;
  /* Only the two things that cannot be read from the repository itself. The
     name, the one-liner, the category and the slug are all derived below and
     the entry can override any of them. */
  const required = ["repo_url"];
  for (const key of required) {
    if (!entry[key] || (Array.isArray(entry[key]) && !entry[key].length)) {
      warn(`${where} is missing "${key}" - skipped`);
      return false;
    }
  }
  const repo = parseRepo(entry.repo_url);
  if (!repo) {
    warn(`${where} repo_url is not a GitHub URL: ${entry.repo_url} - skipped`);
    return false;
  }
  /* Derived from the repository when the entry does not say otherwise. */
  entry.slug = entry.slug || repo.repo.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (seenSlugs.has(entry.slug)) { warn(`${where} duplicate slug "${entry.slug}" - skipped`); return false; }
  /* Case-insensitive, because "defi" is DeFi and nobody typing it means
     anything else. Matching exactly cost a project: Offbook was rejected for
     the lower-case d, told twice, and closed its own pull request. */
  if (entry.category) {
    const match = CATEGORIES.find((c) => c.toLowerCase() === String(entry.category).trim().toLowerCase());
    if (match) {
      entry.category = match;
    } else {
      warn(`${where} category "${entry.category}" is not one of ${CATEGORIES.join(", ")} - kept as Other`);
      entry.category = "Other";
    }
  }
  seenSlugs.add(entry.slug);
  return true;
}

async function buildProject(entry, prev) {
  const { owner, repo } = parseRepo(entry.repo_url);
  const meta = await gh(`/repos/${owner}/${repo}`);
  if (!meta) warn(`${owner}/${repo} is unreachable - is it public?`);
  if (meta?.private) warn(`${owner}/${repo} is private - public repositories are required`);

  /* The team's own file wins for the fields they control. They can change any
     of these without touching our repository, which is the whole point. */
  const manifest = await readManifest(owner, repo);
  if (manifest) {
    entry = {
      ...entry,
      transactions: Array.isArray(manifest.transactions) && manifest.transactions.length
        ? manifest.transactions
        : entry.transactions,
      demo_url: manifest.demo_url || entry.demo_url,
      demo_video: manifest.demo_video || entry.demo_video,
      x_handle: manifest.x_handle || entry.x_handle,
      contracts: Array.isArray(manifest.contracts) && manifest.contracts.length
        ? manifest.contracts
        : entry.contracts,
    };
  }

  const { builders, agents, active_days, sprint_pushes, sprint_base, sprint_root } = await detectBuilders(owner, repo, entry, meta);

  const demoUrl = await resolveDemo(entry, meta, owner, repo);
  const contracts = await resolveContracts(entry);
  const transactions = await verifyTransactions(entry, contracts);
  /* mine === false is a transaction through somebody else's contract and does
     not count; null is a project with nothing deployed, where the question does
     not apply. */
  const verifiedTxs = transactions.filter((t) => t.ok && t.pool && t.mine !== false).length;

  /* Submission is a state the repository is in, not a form someone remembers to
   * fill in at 23:00 on the deadline. Each requirement is checked
   * independently so the hub can tell a team exactly what is still missing,
   * rather than a single pass/fail they have to reverse-engineer. */
  const requirements = {
    demo: !!demoUrl,
    video: !!entry.demo_video,
    mainnet: verifiedTxs >= MIN_MAINNET_TXS,
  };
  const ready = Object.values(requirements).every(Boolean);

  const base = {
    slug: entry.slug,
    /* The repository already carries a name and a description; asking for them
       again is a form to fill in for no gain. */
    name: entry.name || meta?.name || entry.slug,
    one_liner: entry.one_liner || meta?.description || "",
    category: entry.category || "Other",
    repo_url: meta?.html_url || entry.repo_url,
    demo_url: demoUrl,
    demo_video: entry.demo_video || "",
    x_handle: entry.x_handle || "",
    /* Telegram usernames stay in registry.json and never reach projects.json.
       They exist so the team can reach a project's builders, not to be
       published on a page anyone can scrape. */
    inspired_by: entry.inspired_by || "",
    /* Read from spotlight.json, never from the entry - a team editing its own
       row must not be able to star itself. An entry that sets "starred" is
       ignored here and told so by validate-registry.mjs. */
    /* First affiliation among the builders. A project is from StarkWare or the
       Foundation if anyone building it is, and the badge sits where the rank
       would - so one per row, not one per person. */
    affiliation: builders.map((b) => AFFILIATIONS.get((b.login || "").toLowerCase())).find(Boolean) || "",
    /* Filled in below, once the assessment for this head_sha is in hand. */
    starred: false,
    star_reason: "",
    contracts,
    transactions,
    verified_txs: verifiedTxs,
    requirements,
    /* Derived, never declared. A team that meets every requirement is
     * submitted; one that stops meeting them is not. */
    status: ready ? "finished" : "building",
    /* The hub orders on this. Null (unreachable repo) sorts last and renders
     * as an em dash rather than a fake timestamp. */
    pushed_at: meta?.pushed_at || null,
    stars: meta?.stargazers_count ?? 0,
    builders,
    agents,
    active_days,
  };

  const head = await gh(`/repos/${owner}/${repo}/commits?per_page=1`);
  const headSha = head?.[0]?.sha || null;

  /* A repository with nothing in it is not a project yet. Registering the
   * minute the repo is created is fair enough - the entry stays in
   * registry.json and the team keeps its place - but the row it would draw is
   * every column empty, and GitHub sets pushed_at to the creation time, so it
   * sorts above teams that are actually shipping.
   *
   * Three conditions together, because none of them alone means empty:
   * /commits answers 409 on a repository with no commits and null on a rate
   * limit, size is 0 for both an empty repo and an unreachable one, and a
   * project that had code before must never vanish over a bad response. */
  if (!headSha && meta && meta.size === 0 && !prev?.head_sha) {
    console.log(`  ${entry.slug}: no commits yet - not listed`);
    return null;
  }

  /* Nothing new since the last run: reuse everything generated. This is the
   * common case on a 30-minute cron and costs no tokens.
   *
   * An empty summary counts as a miss even when the SHA matches. Otherwise a
   * run that failed to generate one - no key, a rate limit, a bad response -
   * poisons the cache permanently: the SHA never changes again for a finished
   * project, so it would never retry. */
  const summaryUsable = !OPENAI_KEY || !!prev?.summary;
  /* Same shape of trap as the summary one: a run with no key, or one that
     failed to get an answer, must not poison the cache - the SHA does not
     change again on a project that has stopped pushing, so it would sit
     unjudged forever. */
  const assessmentUsable = !STAR_ENABLED || !OPENAI_KEY || !!prev?.assessment?.facts_v2;
  /* Same trap as the others: the wording changed, so what was written under the
     old prompt has to be rewritten once even though nothing was pushed. */
  const descUsable = !OPENAI_KEY || !!prev?.desc_v3 || !prev?.summary;
  /* Sprint totals were added after most projects had already been indexed, and
     a project that has stopped pushing never changes SHA again - so without
     this they would sit at zero for the rest of the sprint. */
  const sprintUsable = prev?.sprint?.computed === 2;
  if (prev && headSha && prev.head_sha === headSha && summaryUsable && assessmentUsable && descUsable && sprintUsable) {
    console.log(`  ${entry.slug}: unchanged`);
    return {
      ...base,
      head_sha: headSha,
      readme_hash: prev.readme_hash || "",
      desc_v3: !!prev.desc_v3,
      summary: prev.summary || "",
      description_long: prev.description_long || "",
      latest_push: prev.latest_push || "",
      tooling: prev.tooling || [],
      agents: prev.agents || [],
      has_readme: !!prev.has_readme,
      additions: prev.additions || 0,
      deletions: prev.deletions || 0,
      churn_pct: prev.churn_pct || 0,
      sprint: prev.sprint || { pushes: sprint_pushes || 0, additions: 0, deletions: 0 },
      /* The verdict stands for this head_sha, but the facts around it are
         checked again: a transaction verifies on-chain without anyone pushing,
         so a project can cross the line between two runs of the cron. */
      assessment: prev.assessment || null,
      starred: starOf(prev.assessment, hasDepth(contracts, prev.tooling), prev.starred),
      star_evidence: depthEvidence(contracts, prev.tooling),
      star_reason: prev.star_reason || "",
    };
  }

  console.log(`  ${entry.slug}: reindexing`);
  const readme = await getTextFile(owner, repo, "README.md");
  const langs = await gh(`/repos/${owner}/${repo}/languages`);
  const tooling = await detectTooling(owner, repo, readme, langs);

  /* Description is regenerated only when the README actually changed - a push
   * that touches only source shouldn't rewrite the project's description. */
  let summary = prev?.summary || "";
  let descriptionLong = prev?.description_long || "";
  const readmeHash = readme ? readme.length + ":" + readme.slice(0, 200) : "";
  /* Regenerate when the README changed, and also whenever we simply don't have
     a summary yet - same reasoning as the SHA cache. A README that never
     changes again would otherwise keep an empty description forever. */
  if (readme && (readmeHash !== (prev?.readme_hash || "") || !summary || !prev?.desc_v3)) {
    const ask = (extra) => openai(
      DESC_SYSTEM + extra,
      `Project name: ${entry.name}\nTeam's own one-liner: ${entry.one_liner}\n\nREADME:\n${readme.slice(0, 6000)}`,
    );

    let out = await ask("");
    /* The ban is checked rather than trusted. Asked once, the model still
       reached for "provides a platform for" and "its architecture includes
       components like" - so the offending words are handed back to it by name
       and it gets one more go. */
    const offenders = (text) => BANNED_WORDS.filter((w) => new RegExp(`\\b${w}\\b`, "i").test(text || ""));
    let bad = offenders(`${out?.summary || ""} ${out?.description_long || ""}`);
    if (out && bad.length) {
      const retry = await ask(`\n\nYour previous answer used these banned words: ${bad.join(", ")}. Write it again without them, saying the same facts in plainer words.`);
      if (retry && !offenders(`${retry.summary || ""} ${retry.description_long || ""}`).length) out = retry;
      else warn(`${entry.slug}: description still uses ${bad.join(", ")}`);
    }
    if (out) {
      summary = out.summary || summary;
      descriptionLong = out.description_long || descriptionLong;
    }
  }

  /* What just landed. With a previous SHA the compare endpoint gives the
   * commits and the changed files in a single call; without one (a project's
   * first index) fall back to recent commits. */
  let latestPush = "";
  let changeText = "";
  /* Lines moved in this push, GitHub-style. On a project's first index there is
   * no previous SHA to diff against, so the head commit's own stats stand in. */
  let additions = 0;
  let deletions = 0;
  if (prev?.head_sha && headSha && prev.head_sha !== headSha) {
    const cmp = await gh(`/repos/${owner}/${repo}/compare/${prev.head_sha}...${headSha}`);
    if (cmp) {
      const msgs = (cmp.commits || []).map((c) => `- ${c.commit.message.split("\n")[0]}`).join("\n");
      const files = (cmp.files || []).slice(0, 30).map((f) => `${f.filename} (+${f.additions}/-${f.deletions})`).join("\n");
      changeText = `Commits:\n${msgs}\n\nFiles changed:\n${files}`;
      for (const f of cmp.files || []) { additions += f.additions || 0; deletions += f.deletions || 0; }
    }
  }
  if (!changeText) {
    const commits = await gh(`/repos/${owner}/${repo}/commits?per_page=10`);
    if (commits?.length) {
      changeText = "Commits:\n" + commits.map((c) => `- ${c.commit.message.split("\n")[0]}`).join("\n");
    }
    if (headSha) {
      const headCommit = await gh(`/repos/${owner}/${repo}/commits/${headSha}`);
      additions = headCommit?.stats?.additions || 0;
      deletions = headCommit?.stats?.deletions || 0;
    }
  }
  if (changeText) {
    const out = await openai(PUSH_SYSTEM, `Project: ${entry.name}\n\n${changeText.slice(0, 5000)}`, 200);
    latestPush = out?.latest_push || prev?.latest_push || "";
  }

  /* Lines the whole sprint has moved, not just this push. One compare from the
     pre-sprint parent to HEAD answers it, and it is only asked when the project
     has actually changed - the cached path carries the last answer forward. */
  let sprintAdd = prev?.sprint?.additions || 0;
  let sprintDel = prev?.sprint?.deletions || 0;
  if (sprint_base && headSha) {
    sprintAdd = 0; sprintDel = 0;
    if (sprint_base !== headSha) {
      const span = await gh(`/repos/${owner}/${repo}/compare/${sprint_base}...${headSha}`);
      for (const f of span?.files || []) { sprintAdd += f.additions || 0; sprintDel += f.deletions || 0; }
    }
    /* The root commit is not in its own comparison, and on a repository born
       this sprint it is usually the bulk of the code. */
    if (sprint_root) {
      const root = await gh(`/repos/${owner}/${repo}/commits/${sprint_root}`);
      sprintAdd += root?.stats?.additions || 0;
      sprintDel += root?.stats?.deletions || 0;
    }
  }

  /* How much of the codebase this push moved. Lines changed over an estimate
   * of the whole tree, from the byte totals GitHub already gave us for language
   * detection - roughly 40 bytes a line across the languages in play here.
   *
   * An estimate is the right call: the alternative is /stats/code_frequency,
   * which answers 202 while GitHub computes it and would make the first run on
   * every new project unreliable. The number is a momentum signal, not an
   * audit, and it only has to be right to the nearest percent. */
  const totalBytes = Object.values(langs || {}).reduce((a, b) => a + b, 0);
  const estimatedLines = totalBytes ? totalBytes / 40 : 0;
  const churnPct = estimatedLines
    ? Math.min(100, Math.round(((additions + deletions) / estimatedLines) * 1000) / 10)
    : 0;

  /* Judged on every project with code in it. This used to wait until a project
     had a demo, a video and three verified transactions, which meant it never
     ran: the star was invisible for the half of the sprint when knowing who is
     building well is worth the most.
     Still one call per project per push, cached on head_sha. */
  let assessment = (prev?.head_sha === headSha && prev?.assessment?.facts_v2 && prev.assessment) || prev?.assessment || null;
  if (STAR_ENABLED && OPENAI_KEY && !assessment?.facts_v2) {
    const contractList = contracts.length
      ? contracts.map((c) => `- ${c.address || c}${c.name ? ` (${c.name})` : ""}`).join("\n")
      : "none declared";
    const langList = Object.entries(langs || {})
      .sort((a, b) => b[1] - a[1])
      .map(([l, bytes]) => `${l} ${Math.round((bytes / (totalBytes || 1)) * 100)}%`)
      .join(", ") || "unknown";
    assessment = await openai(STAR_SYSTEM, [
      `Project: ${entry.name}`,
      `Team's own one-liner: ${entry.one_liner || "-"}`,
      ``,
      `CONTRACTS AND STACK (what is actually there):`,
      `Deployed contracts:\n${contractList}`,
      `Languages by share: ${langList}`,
      `Declared dependencies: ${[...tooling.values()].map((t) => t.label).join(", ") || "none detected"}`,
      `Verified pool transactions: ${verifiedTxs}`,
      ``,
      `README:\n${(readme || "").slice(0, 5000)}`,
    ].join("\n"), 260);
    /* Stamped so the rubric change - facts rather than adjectives - re-judges
       the sentences written under the old wording, once. */
    if (assessment) assessment.facts_v2 = true;
  }
  if (assessment) {
    console.log(`  ${entry.slug}: innovative=${!!assessment.innovative} complex=${!!assessment.complex}`);
  }

  return {
    ...base,
    head_sha: headSha,
    readme_hash: readmeHash,
    /* Written under the plain-language wording. Absent means the sentences came
       from the prompt that let a project say it "utilizes the STRK20 Privacy
       Pool", and they get rewritten once. */
    desc_v3: true,
    churn_pct: churnPct,
    summary,
    description_long: descriptionLong,
    latest_push: latestPush,
    tooling: [...tooling.values()],
    has_readme: !!readme,
    additions,
    deletions,
    /* Totals for the shareable card: what the sprint has cost, against what the
       last push cost, which is what additions and deletions above describe. */
    sprint: { pushes: sprint_pushes || 0, additions: sprintAdd, deletions: sprintDel, computed: 2 },
    /* Kept so the next run reuses the verdict for this head_sha rather than
       asking again and risking a different answer over identical code.
       When a sticky star outlives a judgement that has since flipped, the
       reasoning that earned it is what gets kept: the card explains why a row
       has a star, and booty-bank was about to explain, under its own star, why
       it is the obvious version of itself. */
    assessment: (!(assessment?.innovative && assessment?.complex) && prev?.starred && prev?.assessment?.why_complex)
      ? prev.assessment
      : assessment,
    starred: starOf(assessment, hasDepth(contracts, tooling), prev?.starred),
    star_evidence: depthEvidence(contracts, tooling),
    star_reason: assessment?.reason || prev?.star_reason || "",
  };
}

/* ---------- run ---------- */

const AFFILIATIONS = loadAffiliations();
if (AFFILIATIONS.size) console.log(`affiliations: ${AFFILIATIONS.size} handle(s) badged`);

const registry = JSON.parse(readFileSync(REGISTRY_URL, "utf8"));
if (!Array.isArray(registry)) {
  console.error("registry.json must be an array");
  process.exit(1);
}

/* Previous output doubles as the cache - no separate cache file to keep in
 * sync, and the committed diff shows exactly what changed each run. */
let previous = [];
if (existsSync(PROJECTS_URL)) {
  try { previous = JSON.parse(readFileSync(PROJECTS_URL, "utf8")); } catch { previous = []; }
}
const prevBySlug = new Map(previous.map((p) => [p.slug, p]));

console.log(`resolving ${registry.length} registry entries…`);
if (!OPENAI_KEY) console.log("  (no OPENAI_API_KEY - generated sentences will be omitted)");

const seenSlugs = new Set();
const projects = [];
let rateLimited = false;
for (const [i, entry] of registry.entries()) {
  if (!validate(entry, i, seenSlugs)) continue;

  /* Once the hour's requests are gone they are gone, and every project after
     this one would raise the same error. Keep what each of them looked like on
     the last run rather than losing the whole file: seventy-four projects no
     longer fit in one hour's budget, and a run that throws republishes nothing,
     so the hub was falling three projects behind the registry over a limit that
     resets by itself. */
  if (rateLimited) {
    const prev = prevBySlug.get(entry.slug);
    if (prev) projects.push(prev);
    continue;
  }

  try {
    /* Null means the repository has no commits yet. The registration stands;
       the row does not exist until there is something to show in it. */
    const project = await buildProject(entry, prevBySlug.get(entry.slug));
    if (project) projects.push(project);
  } catch (e) {
    if (!/rate limited/.test(e.message)) throw e;
    rateLimited = true;
    warn(`${e.message} - the rest of this run reuses the last good data`);
    const prev = prevBySlug.get(entry.slug);
    if (prev) projects.push(prev);
  }
}

/* Most recently pushed first. The hub re-sorts client-side too, so this is
 * belt-and-braces - it also makes the committed file readable in a diff. */
projects.sort((a, b) => new Date(b.pushed_at || 0) - new Date(a.pushed_at || 0));

writeFileSync(PROJECTS_URL, JSON.stringify(projects, null, 2) + "\n");
console.log(`wrote projects.json - ${projects.length} projects, ${warnings.length} warnings`);
if (rateLimited) console.log("some projects carry last run's data - the next tick picks them up");
