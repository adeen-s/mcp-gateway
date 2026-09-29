# Regenerate: vhs docs/demo/demo.tape  (from the repo root)
Output docs/demo/demo.gif

Set Shell "bash"
Set FontSize 14
Set Width 1280
Set Height 640
Set Padding 20
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms

Hide
Type `export PS1='\[\e[32m\]$ \[\e[0m\]'; npx tsx src/index.ts --config config/example.yaml > gateway.log 2>&1 & sleep 4; clear`
Enter
Sleep 5s
Show

Type "# a plain MCP client talking to the gateway on :8080"
Enter
Sleep 500ms
Type "npm run demo"
Sleep 300ms
Enter
Sleep 9s

Hide
Type "kill %1; clear"
Enter
