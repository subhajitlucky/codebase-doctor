export interface DemoFile {
  path: string;
  content: string;
}

const CLEAN_FILES: readonly DemoFile[] = [
  {
    path: "package.json",
    content: `${JSON.stringify({
      name: "codebase-doctor-demo-fixture",
      private: true,
      type: "module",
    }, null, 2)}\n`,
  },
  {
    path: "src/config.ts",
    content: `export const config = {
  apiUrl: "https://api.example.com",
  retries: 3,
};
`,
  },
  {
    path: "src/db.ts",
    content: `import { config } from "./config.js";

export function query(sql: string) {
  return { sql, endpoint: config.apiUrl, retries: config.retries };
}
`,
  },
  {
    path: "src/api/route.ts",
    content: `import { query } from "../db.js";

export function getUser(id: string) {
  return query(\`select * from users where id = '\${id}'\`);
}
`,
  },
  {
    path: "src/server.ts",
    content: `import { getUser } from "./api/route.js";
import { query } from "./db.js";

export function handler(id: string) {
  return { user: getUser(id), health: query("select 1") };
}
`,
  },
  {
    path: "src/jobs.ts",
    content: `import { query } from "./db.js";

export function runJob() {
  return query("select 1");
}
`,
  },
];

const BROKEN_FILES: readonly DemoFile[] = [
  {
    path: "src/config.ts",
    content: `export const config = {
  apiUrl: "https://api.example.com",
  retries: 3,
};

export const apiKey = "ghp_7Qm2Xv9Kd4Rn8Ts3Lw6Yp1Bc5";
`,
  },
  {
    path: "src/api/route.ts",
    content: `import { query } from "../db.js";
import { getUserProfile } from "./missing.js";

export function getUser(id: string) {
  return { ...getUserProfile(id), ...query(\`select * from users where id = '\${id}'\`) };
}
`,
  },
];

export const DEMO_FIXTURE_FILES: readonly DemoFile[] = CLEAN_FILES;
export const DEMO_BROKEN_FILES: readonly DemoFile[] = BROKEN_FILES;

export const DEMO_REPLAY_OUTPUT = `Codebase Doctor Demo
====================

Built a disposable fixture repository: a tracked secret, a broken import, and a dependency chain to trace impact. Nothing outside the temp directory was touched.

Changed audit (the agent edit vs HEAD)
--------------------------------------
codebase-doctor brief
scope=changed findings=3 shown=3 coverage=incomplete score=70
[high] source/import-target-missing src/api/route.ts:2 — Confirm the intended module path, then have an authorized human or external agent restore the target or correct the reference. Codebase Doc…
[high] security/secrets/provider-token src/config.ts:6 — Have an authorized human or external coding agent remove the value and rotate it, then rerun the audit.
[info] repository/no-visible-tests (repository) — Add automated tests in a recognized test path or using a common test naming pattern.
coverage-limitations: repository: partial, backend: not-selected, database: skipped, performance: partial

Blast radius
------------
src/config.ts → src/db.ts
src/config.ts → src/db.ts → src/jobs.ts
src/api/route.ts → src/server.ts

Exit code 1: this is what CI sees at --fail-on high.
The fixture directory was removed. Every finding carries evidence; coverage limits are printed, never hidden.
`;
