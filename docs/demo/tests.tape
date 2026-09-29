# Regenerate: vhs docs/demo/tests.tape  (from the repo root; runs in a /tmp copy so no home path shows)
Output docs/demo/tests.gif

Set Shell "bash"
Set FontSize 14
Set Width 1280
Set Height 520
Set Padding 20
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms

Hide
Type `export PS1='\[\e[32m\]$ \[\e[0m\]'; rm -rf /tmp/mcp-gateway && rsync -a --exclude node_modules --exclude .git ./ /tmp/mcp-gateway/ && ln -s "$PWD/node_modules" /tmp/mcp-gateway/node_modules && cd /tmp/mcp-gateway; clear`
Enter
Show

Type "npm test"
Sleep 300ms
Enter
Sleep 10s
