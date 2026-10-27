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
npm test                      # builds and runs 29 tests
node dist/aegis.mjs check examples/research.aegis
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
| `run get\|post\|read\|write\|echo "..."` | The one action. `post` takes `body "..."`, `write` takes `content "..."`, both take `header Name = "value"`. |
| `then json`, `then pick a.b.0`, `then trim 500` | Transform the result, in order. |
| `output text\|json\|number` | The result type. |

Templates: `{input}` and `{secret.NAME}`. Values are escaped for where they land (URL-encoded in URLs, JSON-escaped in bodies). Write `{{` and `}}` for literal braces.

## GitHub Actions does all the building

Nothing needs to be built on your machine.

| Workflow | When | What |
| --- | --- | --- |
| `ci.yml` | every push and pull request | Type check, build, 29 tests on Node 20 and 22, example check, CLI and MCP smoke test. Uploads the CLI and the playground as artifacts. |
| `pages.yml` | push to `main` | Builds and deploys the playground to GitHub Pages. |
| `release.yml` | tag `v*` | Builds `aegis.mjs` and attaches it to a GitHub release. |

One-time setup: repository **Settings, Pages, Source: GitHub Actions**. Then every push to `main` updates the live playground. To ship a release: create a tag such as `v0.1.0`.

Prefer Vercel? Import the repo, set the build command to `npm run build` and the output directory to `site`.

## Known limits

- Aegis enforces permissions in its own runtime. It is not an OS sandbox. If you run untrusted code on the same machine, add container or OS isolation underneath.
- It does not defend against DNS rebinding or block private IP ranges unless you simply do not allow them.
- Paths are POSIX-style and relative to the working folder.
- Redirects cannot be followed inside a browser (browsers hide them), so the playground refuses them.

## Project layout

```
src/        lexer, parser, checker, runtime, exporters, MCP handler, CLI
playground/ the web playground (bundled by esbuild into site/)
examples/   research.aegis, github.aegis, risky.aegis (wrong on purpose)
test/       node:test suite
scripts/    build.mjs
```

MIT licensed.
