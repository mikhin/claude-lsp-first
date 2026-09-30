# claude-lsp-first

A Claude Code hook that stops Claude from grepping for code symbols and sends it to the LSP tool
instead.

Claude Code has an LSP tool, but Claude rarely reaches for it: it greps through Bash, reads a match,
guesses the next name, greps again. Over five weeks of sessions with a TypeScript LSP plugin
installed: about 11,000 greps, zero LSP calls. A reference search through the LSP is one call that
returns only real usages — no same-named locals, comments or strings mixed in.

```
grep for code symbols (isLoggedIn). Use the LSP tool instead: it returns only real references, in one call. …
```

## Install

Needs Node 18+ and a [code intelligence plugin](https://code.claude.com/docs/en/plugins/code-intelligence)
for your language, so the LSP tool exists.

```sh
curl -o ~/.claude/hooks/lsp-first.mjs \
  https://raw.githubusercontent.com/mikhin/claude-lsp-first/main/lsp-first.mjs
```

Then in `~/.claude/settings.json`, or a project's `.claude/settings.local.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/lsp-first.mjs" }] }
    ]
  }
}
```

## What it blocks

A recursive `grep`, `rg` or `git grep` inside the project where every pattern is a code symbol:
`camelCase`, `PascalCase` with two humps, `$store`, `SCREAMING_CASE`. Alternations count:
`"isGuest\|isLoggedIn"`.

The deny message tells Claude to call `workspaceSymbol`, then `findReferences`, `goToDefinition` or
the call hierarchy at the returned position, several symbols in parallel.

## What it lets through

- plain words, strings, CSS classes, regexes: `grep -rn "loading" src`, `grep -rn "useStore(\$cart)" src`
- a single file, or a grep without `-r`
- `node_modules`, `.claude`, and `.md` / `.json` / `.yml` / `.css` / `.html` / `.txt` / `.log`
- anything outside the project, including after a `cd` out of it
- `git grep` over a revision (`HEAD~3`, a commit)
- a grep after a pipe — that filters output, it does not search code
- patterns built from shell variables (`"$name"`) and heredoc bodies
- any command ending in `# text-search` — the way out the deny message offers for text matches

## Caveats

- The shell parsing is a small tokenizer, not bash. A command it cannot parse goes through.
- Claude can learn to append `# text-search` to everything. Count how often it does before trusting
  the hook.
- The first `workspaceSymbol` after the language server starts can come back empty while it
  indexes. The deny message tells Claude to retry once.

## Test

```sh
node lsp-first.mjs --test
```

## License

MIT
