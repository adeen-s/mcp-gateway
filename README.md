# mcp-gateway

[![CI](https://github.com/adeen-s/mcp-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/adeen-s/mcp-gateway/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)

**Every AI client in your org is wired straight to every MCP server, each with its own credentials and no shared policy, rate limits or audit trail. `mcp-gateway` puts one authenticated, policy-enforcing, observable endpoint in front of all of them.**

```mermaid
flowchart LR
    C1[MCP client A] -->|streamable HTTP /mcp| AUTH
    C2[MCP client B] -->|streamable HTTP /mcp| AUTH

    subgraph GW [mcp-gateway]
        direction LR
        AUTH[auth<br/>api-key · jwt · mtls] --> RBAC[rbac<br/>allow / deny globs]
        RBAC --> RL[rate limiter<br/>token bucket + quota]
        RL --> CACHE[result cache<br/>idempotent tools]
        CACHE --> RTR[router<br/>namespacing]
    end

    RTR -->|stdio| U1[upstream: filesystem]
    RTR -->|streamable HTTP| U2[upstream: github]
    RTR -->|SSE| U3[upstream: internal tools]

    GW -.-> REDIS[(Redis<br/>limits + cache)]
    GW -.-> OBS[(OTel traces · Prometheus<br/>pino logs · audit log)]
    ADM[admin API :9090] --- GW
```

## Why it exists

MCP adoption inside a team quickly becomes **N clients × M servers**. Every client holds credentials for every server. Nobody can say which agent called which tool, one runaway loop can burn a paid API's quota, and a flaky server takes agents down with it.

`mcp-gateway` changes that to **clients → gateway → servers**:

- **One auth surface.** Clients present an API key, JWT or client certificate and get mapped to a tenant. Upstream credentials stay on the gateway.
- **One policy engine.** Per-tenant allow/deny globs decide which tools and resources each tenant can see and call.
- **Cost and abuse control.** Token-bucket rate limits per tenant and per tool, plus hard daily quotas.
- **One place to look.** Prometheus metrics, OpenTelemetry traces and a JSONL audit record of every decision.
- **Blast-radius control.** Circuit breakers, timeouts, health checks and safe retries, so one bad upstream can't take down `tools/list` for everyone.

To clients, the gateway is just another MCP server: one URL, with tools namespaced as `<upstream>__<tool>`.

## Quickstart

### Docker Compose (gateway + Redis + example upstream)

```bash
git clone https://github.com/adeen-s/mcp-gateway && cd mcp-gateway
docker compose up --build
```

- MCP endpoint: `http://localhost:8080/mcp` (header `x-api-key: dev-acme-key-123`)
- Admin and metrics: `http://localhost:9090` (`Authorization: Bearer dev-admin-token`)
- Rate limits and the result cache are stored in Redis (`STATE_BACKEND=redis`).

### From source (Node ≥ 20, no external services)

```bash
npm ci
npm run dev -- --config config/example.yaml
```

The example config spawns the bundled echo server (`examples/upstream-echo`) over stdio, so the gateway runs with no other dependencies.

### Point a client at it

Any MCP client that supports streamable HTTP with custom headers works. For example, with the [MCP Inspector](https://github.com/modelcontextprotocol/inspector), run `npx @modelcontextprotocol/inspector`, choose **Streamable HTTP**, enter `http://localhost:8080/mcp` and add the header `x-api-key: dev-acme-key-123`.

## Demo

With the gateway running (either way above):

```bash
npm run demo        # GATEWAY_URL / API_KEY env vars override the defaults
```

[`examples/demo.mjs`](examples/demo.mjs) is a plain MCP SDK client. This is its real output against the example config:

```text
▸ Unauthenticated request
  HTTP 401

▸ tools/list as tenant "acme" (filtered by RBAC)
  echo__echo
  echo__add
  echo__counter

▸ Call echo__echo (routed to the "echo" upstream)
  ok: [echo] hello

▸ Call echo__fail (denied by RBAC even though the upstream has it)
  rejected: MCP error -32043: access to tool "echo__fail" is denied

▸ Call echo__add twice with the same args (the second is a cache hit: "cached":true in the audit log)
  ok: 42
  ok: 42

▸ Keep calling echo__add past its per-tool limit (burst 5, refill 2/s)
  #1 ok: 2
  #2 ok: 4
  #3 ok: 6
  #4 rejected: MCP error -32029: rate limit exceeded for tool "echo__add" (tenant "acme")
  ...
```

The same run as the gateway sees it:

```text
$ curl -s localhost:9090/metrics | grep -E '^mcpgw_(tool_calls|cache_hits|ratelimit|rbac)'
mcpgw_tool_calls_total{tenant="acme",tool="echo__add",upstream="echo",status="ok"} 4
mcpgw_tool_calls_total{tenant="acme",tool="echo__add",upstream="cache",status="ok"} 1
mcpgw_ratelimit_rejections_total{tenant="acme",scope="tool"} 5
mcpgw_rbac_denials_total{tenant="acme",kind="tool"} 1
mcpgw_cache_hits_total{tool="echo__add"} 1

# audit log (stdout), one JSON line per decision (ts trimmed)
{"event":"tool_call","tenant":"acme","authMethod":"apiKey","subject":"key:7738f99ca121","tool":"echo__add","upstream":"echo","status":"ok","durationMs":1,"cached":false}
{"event":"tool_call","tenant":"acme","tool":"echo__add","status":"ok","cached":true}
```

## Architecture

### Request path

Every request to `/mcp` goes through the same pipeline:

1. **Auth** ([`src/auth`](src/auth)). Providers run in order (API key → JWT → mTLS) until one resolves a tenant identity. A present-but-invalid token is a hard failure; it never falls through. Auth runs on **every** request, not just session creation, so a revoked key can't keep using an open session.
2. **Tenant check.** An authenticated identity whose tenant isn't configured is rejected with 403 rather than getting default access.
3. **RBAC** ([`src/rbac`](src/rbac)). Allow/deny globs over namespaced tool names and resource URIs. Deny wins. `tools/list` and `resources/list` are filtered, so tenants only see what they can call.
4. **Rate limit** ([`src/ratelimit`](src/ratelimit)). Tenant-wide bucket, then the first matching per-tool bucket, then the daily quota. Memory or Redis (atomic Lua).
5. **Result cache** ([`src/cache`](src/cache)). Opt-in per tool glob, with keys based on canonicalised arguments. Error results are never cached. Invalidation is available through the admin API.
6. **Router** ([`src/routing`](src/routing)). Strips the namespace and forwards the call to the owning upstream. Resources keep their URIs and are routed through a URI → upstream index.

Each upstream connection ([`src/routing/upstream.ts`](src/routing/upstream.ts)) reconnects lazily and has its own circuit breaker, per-call timeout and periodic health check. Idempotent operations (`list`, `read`) retry with jittered exponential backoff. **Tool calls are never retried**: the gateway can't know whether a tool is safe to run twice.

Errors reach clients as JSON-RPC codes: `-32043` forbidden, `-32029` rate-limited or over quota, `-32602` unknown tool, `-32001` upstream timeout.

### Code layout

```text
src/
  index.ts              CLI entry: load config, start, SIGHUP = reload, graceful shutdown
  server.ts             Gateway: HTTP listener, sessions, the request pipeline above
  config/               zod schema + YAML loader with ${ENV} / ${ENV:-default} interpolation
  auth/                 apiKey · jwt (JWKS or HMAC) · mtls providers + chain
  rbac/                 glob matcher + per-tenant policy engine
  ratelimit/            token bucket, memory + Redis stores, limiter service
  cache/                result cache, memory + Redis stores
  routing/              namespacing, router, upstream connections (stdio · http · sse)
  resilience/           circuit breaker, retry/timeout, health monitor
  observability/        pino logger, Prometheus metrics, OTel tracing, audit log
  admin/                admin HTTP API
examples/
  upstream-echo/        tiny stdio MCP server used by the example config and tests
  demo.mjs              the client walkthrough above
```

### Configuration

One YAML file (`--config path` or `MCP_GATEWAY_CONFIG`), validated at startup and on reload with readable errors. `${VAR}` and `${VAR:-default}` are read from the environment, so secrets stay out of the file. A referenced variable with no default must be set, or startup fails. [`config/example.yaml`](config/example.yaml) is the annotated reference:

```yaml
server:     { port: 8080, path: /mcp }       # public MCP endpoint (TLS/mTLS optional)
admin:      { port: 9090, token: ${ADMIN_TOKEN} }
namespace:  { separator: "__", onCollision: error }   # or "first"
upstreams:  [...]                            # stdio | http | sse, each with timeout/retry/breaker
auth:       { providers: [...] }             # apiKey | jwt | mtls -> tenant id
tenants:    [...]                            # rbac + rate limits per tenant
rateLimit:  { backend: memory | redis }
cache:      { enabled: true, tools: [...] }  # idempotent tool globs only
observability: { logLevel, metrics, tracing, audit }
```

<details>
<summary>Auth, RBAC and rate-limit examples</summary>

```yaml
auth:
  providers:
    - type: apiKey                 # compared by SHA-256 digest, constant-time
      header: x-api-key
      keys:
        - { key: ${ACME_API_KEY}, tenant: acme }
    - type: jwt                    # JWKS or hmacSecret; tenant from a claim
      jwksUri: https://auth.example.com/.well-known/jwks.json
      audience: mcp-gateway
      tenantClaim: tenant
    - type: mtls                   # enable client certs under server.tls first
      certs:
        - { subjectCN: acme.client, tenant: acme }   # or fingerprint256

tenants:
  - id: acme
    rbac:
      allowTools: ["github__*", "search__*"]   # allow-list (optional)
      denyTools: ["github__delete_*"]          # deny always wins
    rateLimit:
      requests: { ratePerSec: 10, burst: 20 }  # tenant-wide
      perTool:
        search__web: { ratePerSec: 1, burst: 3 }
      dailyQuota: 5000
```

</details>

### Admin API and observability

The admin API runs on a separate listener (localhost by default) so it can be firewalled on its own. Routes under `/admin/*` require `Authorization: Bearer <admin.token>`.

| Route | Purpose |
|---|---|
| `GET /healthz` | `ok` / `degraded` / `unhealthy` (503) from upstream health |
| `GET /metrics` | Prometheus: calls, latency, cache hit/miss, rate-limit and RBAC rejections, breaker state, upstream health, sessions |
| `GET /admin/upstreams` | per-upstream connection, health, circuit state, last check |
| `GET /admin/tenants` | configured tenants and their policies |
| `POST /admin/cache/invalidate` | `{"tool": "search__*"}`; omit the body to flush everything |
| `POST /admin/reload` | re-read and validate the config, then hot-swap tenants, auth, limits, cache and upstreams (also on `SIGHUP`) |

Set `observability.tracing.enabled: true` and an OTLP endpoint to export an OpenTelemetry span per proxied tool call. The audit log records auth failures, RBAC denials, rate-limit rejections, sessions and every tool call and resource read. Argument payloads are deliberately left out because they may contain secrets.

## Tests

```bash
npm test            # vitest: 77 tests, ~6s, no external services needed
npm run typecheck   # tsc --strict
npm run lint        # eslint
npm run build       # emit dist/
```

| Suite | What it covers |
|---|---|
| [`src/gateway.test.ts`](src/gateway.test.ts) | **End to end:** a real SDK client over streamable HTTP → gateway → real stdio upstream. Covers 401/403, RBAC-filtered listing and denial, proxying, the cache hit shown in the audit log, per-tool rate limiting, unknown-namespace errors, and admin auth and validation. |
| [`src/integration.test.ts`](src/integration.test.ts) | Router + upstream connections against two real stdio upstreams: aggregation, namespacing, routing |
| `*/*.test.ts` | Units: circuit breaker state machine, retry/backoff/timeout, token bucket, RBAC decisions, cache keys/TTL/invalidation, namespace collisions, config validation and env interpolation |

The protocol layer is never mocked: upstreams are real processes speaking MCP through the official SDK transports. CI runs lint, typecheck, tests and the build on Node 20 and 22, plus a Docker image build.

## Roadmap

- [ ] **Session reaping.** Idle sessions from clients that disappear without a `DELETE` are kept until restart. Add an idle TTL.
- [ ] **Prompts and resource templates.** Only tools and resources are proxied today. Add `prompts/*` and `resources/templates/list`.
- [ ] **Change notifications.** Forward upstream `list_changed` notifications to connected clients.
- [ ] **Per-tenant upstream credentials.** Pass through or exchange the caller's token instead of using one shared credential per upstream.
- [ ] **Shared session state.** Sessions live in process memory, so multiple replicas need sticky routing on `mcp-session-id`.
- [ ] **Published artifacts.** Publish an npm package and a GHCR container image on tag.

## Status

**v0.1, early but functional.** All the features above are implemented and covered by the test suite, and the Docker Compose stack is verified end to end (including the Redis backends). It hasn't yet been run under production load. Expect config keys to change before 1.0, and see the roadmap for known gaps, especially sticky sessions if you run more than one replica. Issues and PRs are welcome.

## License

[MIT](LICENSE) © [Adeen Shukla](https://github.com/adeen-s)
