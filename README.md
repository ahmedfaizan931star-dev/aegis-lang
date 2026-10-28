# Aegis

A small language for defining AI agent tools that can only do what you allow.

```
tool search_web
  description "Search the web and return the top results as JSON"
  input query: text "What to search for"
  input count: number "How many results" = 5
  allow network "api.search.example"
  deny files, shell
  secret SEARCH_KEY
  limit time 5s
  limit calls 10/min
  cache 60s
  retry 2
  approve untrusted
  run get "https://api.search.example/v1/search?q={query}&n={count}" header Authorization = "Bearer {secret.SEARCH_KEY}"
  then json
  output json
```

One file describes the tool, its permissions, its limits and its secrets. Aegis checks it before it runs, enforces it while it runs, and exports it to MCP, OpenAI or Anthropic tool formats.

## Install in 3 steps

1. **Install:** `npm i -g aegis-lang` (or skip this and put `npx aegis-lang` in front of every command below).
2. **Write** a file called `tools.aegis` (copy one from `examples/`) and check it: `aegis check tools.aegis`
3. **Use it:** `aegis test tools.aegis` runs its built-in tests, `aegis serve tools.aegis` serves the tools to Claude Desktop or any MCP client.

Want colours and live error underlining in VS Code? Download `aegis-vscode-<version>.vsix` from the Releases page, then Extensions, the `...` menu, **Install from VSIX**.

## What makes it secure

| Protection | How it works |
| --- | --- |
| Default deny | A tool can only reach hosts and folders it lists. There is no shell, no eval, no raw code. |
| Fixed hosts | The host in a URL must be literal. A placeholder can never change where a request goes. |
| Safe redirects | Every redirect hop is checked against the allow list. Credentials are dropped when the host changes. |
| Path jail | Paths are normalised. `..` and escapes are refused, statically and at runtime. |
| Hidden secrets | Secrets come from environment variables, only appear in URLs, headers and bodies, and are redacted from output, errors and logs. |
| Injection guard | Output from the web or files is marked untrusted. Once a session has seen untrusted content, tools marked `approve untrusted` need a human. The MCP server also wraps untrusted output in markers. |
| Approval by default | Tools that write files or POST data need human approval unless you write `approve never`. |
| Limits | Time limit, call rate, output size, response size, retries. |
| Audit log | Every decision is logged in a SHA-256 hash chain. Editing or dropping an entry breaks verification. |
| Static checks | Unknown inputs, undeclared secrets, secret leaks, bad hosts, path escapes, wildcards, conflicts and more are caught before anything runs, with line numbers and suggestions. |

## Use it

```bash
npm ci
npm test                      # builds and runs all the tests
node dist/aegis.mjs check examples/research.aegis
node dist/aegis.mjs test examples/research.aegis      # run the test "..." blocks inside the file
node dist/aegis.mjs report examples/research.aegis
node dist/aegis.mjs export examples/research.aegis --format mcp
node dist/aegis.mjs run examples/research.aegis search_web query=hello --dry-run --audit
node dist/aegis.mjs serve examples/research.aegis      # MCP server over stdio
```

Use it from an MCP client such as Claude Desktop:

```json
{
  "mcpServers": {
    "my-tools": { "command": "node", "args": ["aegis.mjs", "serve", "tools.aegis"], "env": { "SEARCH_KEY": "..." } }
  }
}
```

Side-effect tools are refused over MCP unless you start the server with `--approve`.

## Language reference

Every line inside a tool starts with one keyword.

| Line | Meaning |
| --- | --- |
| `description "..."` | What the tool does. Models choose tools from this. |
| `input name: text\|number\|bool ["help"] [= default]` | A parameter. No default means required. |
| `allow network "host", "*.domain.com"` | Hosts the tool may call. |
| `allow read "./dir"`, `allow write "./dir"` | Folders the tool may read or write. |
| `deny network, read, write, files, shell, env` | Explicit denials. Contradicting an `allow` is an error. |
| `secret NAME` | A secret read from the environment variable `NAME`. |
| `limit time 5s`, `limit calls 10/min`, `limit output 20kb` | Time, rate and output size. |
| `cache 60s`, `retry 2` | Cache reads, retry network errors (0 to 5). |
| `approve never\|always\|untrusted` | When a human must approve a call. |
| `run get\|post\|read\|write\|echo "..."` | One step. `post` takes `body "..."`, `write` takes `content "..."`, both take `header Name = "value"`. A tool can have several (see below). |
| `run let name = get "..."` | Same, and saves the result as `{name}` for the steps after it. |
| `then json`, `then pick a.b.0`, `then trim 500` | Transform the result of the `run` line above it, in order. |
| `output text\|json\|number` | The result type (of the last step). |
| `test "name"` | Starts a built-in test (top level, like `tool`). See below. |

Templates: `{input}` and `{secret.NAME}`. Values are escaped for where they land (URL-encoded in URLs, JSON-escaped in bodies). Write `{{` and `}}` for literal braces.

## Multi-step tools

A tool can have several `run` steps. Name a step with `let` and the steps after it can use its result as `{name}`:

```
tool lookup_then_fetch
  description "Look up an id for a topic, then fetch the details for that id"
  input topic: text "What to look up"
  allow network "api.example.com"
  limit time 6s
  limit calls 20/min
  run let found = get "https://api.example.com/lookup?q={topic}"
  then json
  then pick id
  run get "https://api.example.com/items?id={found}"
  then json
  output json
```

`then` lines belong to the `run` line above them. The last step's result is the tool's result, and `output` applies to it.

Every step is checked exactly like a one-step tool, both before running and while running:

- Hosts, folders, headers and secret rules apply to every step. A step result is placeholder data like an input: it is URL-encoded in URLs, can never be part of the host, and is jailed to the allowed folders in paths.
- Secrets are redacted from every step result before the next step can see it.
- Approval is decided for the whole tool, once, before any step runs. If any step has side effects (post, write) the tool needs approval by default.
- `limit time` covers all steps together, and once it runs out no further step starts. `limit calls` counts tool calls, not steps.
- `cache` only works if every step just reads. `retry` applies to each network step.
- New warning `untrusted-flow`: a step that sends or saves data that came from the web or a file, in a tool where a human does not approve every call.
- At most 10 steps per tool. Step names are lowercase and cannot clash with inputs.

The approval prompt shows the tool and its inputs, not the data fetched in between. Keep that in mind when you write the tool.

## Tests inside your .aegis file

```
test "blocks a redirect to an evil host"
  mock "https://docs.example.org/" status 302 header Location = "https://evil.example.net/steal"
  call fetch_page slug="intro"
  expect denied

test "second step uses the first result"
  mock "https://api.example.com/lookup" body "{\"id\": 42}"
  call lookup_then_fetch topic="cats"
  expect ok
  expect output contains "items?id=42"
```

Run them with `aegis test file.aegis` (or `aegis test` to run every `.aegis` file under the current folder). Tests run **offline**: every request gets Aegis's simulated dry-run answer (a JSON text that contains the URL, method and sent headers), unless a `mock` says otherwise. Nothing real is fetched or written. Each test starts with a fresh runtime, so limits and caches do not leak between tests.

| Line | Meaning |
| --- | --- |
| `mock "url-start" [status 302] [body "text"] [header Name = "value"]` | Requests whose URL starts with this text get this answer. Mock bodies are plain text (no `{{` doubling). |
| `call tool name="text" count=3 flag=true` | Call a tool. Add the words `untrusted` (the model has already seen outside content) and/or `approved` (a human says yes). |
| `expect ok` | The call worked. |
| `expect denied` | A security rule said no: `DENIED` (blocked host, folder or redirect, or a human said no) or `NEEDS_APPROVAL`. |
| `expect error [CODE]` | The call failed. With a code, it must be that one (`BAD_INPUT`, `RATE_LIMITED`, `TIMEOUT`, `HTTP_ERROR`, `MISSING_SECRET`, `FAILED`, ...). |
| `expect output "x"` / `contains "x"` / `not contains "x"` | The tool's output is exactly, contains, or does not contain the text. |

A test can have several `call` lines; each `expect` checks the call above it. `aegis test` exits with 1 if a test fails, if the file has errors, or if it finds no tests at all (add `--allow-empty` to allow that). `--filter text` runs only tests whose name contains the text.

## VS Code extension

`aegis-vscode-<version>.vsix` (on every release, and as a CI artifact) gives you syntax colours for `.aegis` files and live underlining: the real Aegis checker runs while you type, errors are red, warnings yellow, hints show on hover. Settings: `aegis.check.enable`, `aegis.check.delayMs`.

## Use it as a library

```js
import { analyze, Runtime, runTests } from 'aegis-lang';
import { nodeHost } from 'aegis-lang/node';   // real network, disk and process.env

const { program, ok, diagnostics } = analyze(source);
const result = await new Runtime(program, nodeHost()).call('search_web', { query: 'cats' });
```

Works with `import` and `require`, and ships its own types. `analyze()` and `parse()` remember their results per source text (up to 64 texts, about 1 MB in total) and return them frozen, so asking again for the same text is a lookup. `clearCaches()` empties them.

## Speed

`npm run bench` prints the numbers for your machine (CI prints them too). Measured on one Linux sandbox with Node 22, median of 7 rounds, before this upgrade versus now:

| | Before | Now |
| --- | --- | --- |
| Check a 5-tool file, new text | about 110 µs | about 250 to 320 µs |
| Check a 100-tool file, new text | about 1.5 ms | about 2.5 to 2.7 ms |
| Check a 1000-tool file, new text | about 23 ms | about 29 ms |
| Check the same text again | same as new text | about 0.1 to 1 µs (cache hit) |
| Run a 1-step tool (dry-run host) | about 150 to 180 µs | about 165 µs |

Checking text it has never seen is slower than before (the new language features and the cache bookkeeping cost something), by about 0.15 ms on a small file. Checking text it has seen is thousands of times faster. That helps editors, servers and test suites that re-check the same text. It does not help a one-off `aegis check`.

## GitHub Actions does all the building

Nothing needs to be built on your machine.

| Workflow | When | What |
| --- | --- | --- |
| `ci.yml` | every push to `main` and every pull request | Type check, build, all tests on Node 20 and 22, example check, `aegis test`, CLI and MCP smoke test, installs the packed npm package like a user would. On Node 22 also prints the speed numbers and builds the `.vsix`. Uploads the CLI, the `.vsix` and the playground as artifacts. |
| `pages.yml` | push to `main` | Builds and deploys the playground to GitHub Pages. |
| `release.yml` | tag `v*` | Checks the tag matches `package.json`, builds and tests, then attaches `aegis-lang-<version>.tgz`, `aegis-vscode-<version>.vsix`, `aegis.mjs` and `SHA256SUMS` to a GitHub release. Publishes to npm if the `NPM_TOKEN` secret exists. |

### The only settings you must change on GitHub

1. **Pages:** repository **Settings, Pages, Build and deployment, Source: GitHub Actions**. Without this `pages.yml` fails. (One time.)
2. **`NPM_TOKEN` secret, only if you want npm publishing.** Skip it and releases still work, they just skip the npm step.
   - On npmjs.com: profile picture, **Access Tokens, Generate New Token, Granular Access Token**.
   - Permissions: **Packages and scopes, Read and write**, applied to **All packages** (the package does not exist yet, so it cannot be picked from the list). Tick **Bypass two-factor authentication** (CI cannot type a code). npm limits write tokens to 90 days at most, so you will need to make a new one before it expires.
   - In GitHub: repository **Settings, Secrets and variables, Actions, New repository secret**. Name: `NPM_TOKEN`. Value: the token.
   - Old npm "classic" tokens no longer exist (npm revoked them in late 2025). Once the package exists you can switch to npm "Trusted Publishing" and drop the token.
3. Nothing else. The workflows ask for the permissions they need themselves.

### Shipping a release

1. Change `"version"` in `package.json` (for example to `0.2.0`) and commit it to `main`.
2. Create the tag `v0.2.0`. On the GitHub website or app: **Releases, Draft a new release, Choose a tag, type `v0.2.0`, Create new tag, Publish release**. (A tag whose version contains a `-`, like `v0.3.0-rc.1`, becomes a pre-release and goes to npm under the `next` tag.)
3. Wait for the **Release** workflow in the Actions tab to turn green. The files appear on the release.

Prefer Vercel for the playground? Import the repo, set the build command to `npm run build` and the output directory to `site`.

## Known limits

- Aegis enforces permissions in its own runtime. It is not an OS sandbox. If you run untrusted code on the same machine, add container or OS isolation underneath.
- It does not defend against DNS rebinding or block private IP ranges unless you simply do not allow them.
- Paths are POSIX-style and relative to the working folder.
- Redirects cannot be followed inside a browser (browsers hide them), so the playground refuses them.
- In a multi-step tool, a human approves the whole tool before step 1. The approval prompt does not show what the earlier steps fetched.
- `aegis test` uses simulated answers. It proves the rules you wrote hold, not that a real server behaves the way a mock says.
- Cached `analyze()` and `parse()` results are frozen. Code that tried to change one would now throw instead of silently changing it for everyone.

## Project layout

```
src/        lexer, parser, checker, runtime, test runner, exporters, MCP handler, CLI
playground/ the web playground (bundled by esbuild into site/)
examples/   research.aegis, github.aegis, multistep.aegis, risky.aegis (wrong on purpose)
vscode/     the VS Code extension (grammar, language settings, live checker)
test/       node:test suites
scripts/    build.mjs, build-vsix.mjs, bench.mjs, test.mjs
```

MIT licensed.
