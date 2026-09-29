# Regenerate: vhs docs/demo/ops.tape  (from the repo root)
Output docs/demo/ops.gif

Set Shell "bash"
Set FontSize 14
Set Width 1280
Set Height 600
Set Padding 20
Set Theme "Catppuccin Mocha"
Set TypingSpeed 30ms

Hide
Type `export PS1='\[\e[32m\]$ \[\e[0m\]' ADMIN_TOKEN=dev-admin-token; npx tsx src/index.ts --config config/example.yaml > gateway.log 2>&1 & sleep 4; npm run -s demo > /dev/null; clear`
Enter
Sleep 7s
Show

Type "# the operator's view on the admin port (:9090)"
Enter
Type "curl -s localhost:9090/healthz | jq -c"
Enter
Sleep 1500ms

Type "curl -s -H 'authorization: Bearer dev-admin-token' localhost:9090/admin/upstreams | jq -c '.upstreams[0]|{name,healthy,circuitState}'"
Enter
Sleep 2s

Type "curl -s localhost:9090/metrics | grep -E '^mcpgw_(tool_calls|cache_hits|ratelimit|rbac)'"
Enter
Sleep 2500ms

Type `grep '"event":"tool_call"' gateway.log | head -3 | jq -c '{tenant,authMethod,tool,upstream,status,cached}'`
Enter
Sleep 2500ms

Type `curl -s -X POST -H 'authorization: Bearer dev-admin-token' localhost:9090/admin/cache/invalidate -d '{"tool":"echo__*"}' | jq -c`
Enter
Sleep 2s

Type "curl -s -X POST -H 'authorization: Bearer dev-admin-token' localhost:9090/admin/reload | jq -c"
Enter
Sleep 3s

Hide
Type "kill %1; clear"
Enter
