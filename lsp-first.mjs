#!/usr/bin/env node
// PreToolUse hook on Bash: blocks a recursive grep / rg / git grep whose pattern is only code symbols and points Claude to the LSP tool.
// A denied command rerun with "# text-search" appended goes through; the marker on a command never denied is ignored.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const SYMBOL = /^(?:\$[A-Za-z_]\w*|[a-z][a-z0-9]*[A-Z]\w*|[A-Z][a-z0-9]+[A-Z]\w*|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)$/;
const NOT_CODE = /node_modules|\.claude\b|\.(?:jsonl?|ya?ml|md|css|html|txt|log)\b/;
const VALUE_FLAGS = new Set(["-A", "-B", "-C", "-m", "-f", "-g", "-t", "-T", "--glob", "--type", "--max-count", "--include", "--exclude", "--exclude-dir"]);
const OPERATORS = "\n;&|()<>";
const ESCAPE = "# text-search";

const reason = (names) =>
  `grep for code symbols (${names.join(", ")}). Use the LSP tool instead: it returns only real references, in one call. ` +
  `ToolSearch select:LSP if it is deferred, then LSP workspaceSymbol (query: the name) and, at the returned position, ` +
  `findReferences / goToDefinition / incomingCalls / outgoingCalls. Several symbols: issue the LSP calls in parallel in one turn. ` +
  `If workspaceSymbol returns nothing, the server is still indexing: retry once. ` +
  `Need text matches (comments, strings, docs, non-code files)? Rerun the same command with "${ESCAPE}" appended; ` +
  `the marker only lets through a command that was denied first.`;

const commandKey = (command) =>
  createHash("sha1").update(command.replaceAll(ESCAPE, "").trim()).digest("hex");

function tokenize(command) {
  const tokens = [];
  let word = null;
  let expands = false;
  const endWord = () => {
    if (word !== null) tokens.push({ word, expands });
    word = null;
    expands = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "'") {
      const close = command.indexOf("'", i + 1);
      if (close < 0) throw new Error("unterminated quote");
      word = (word ?? "") + command.slice(i + 1, close);
      i = close;
    } else if (c === '"') {
      let text = "";
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        if (command[j] === "\\" && '$`"\\\n'.includes(command[j + 1])) j++;
        else if (command[j] === "$") expands = true;
        text += command[j];
      }
      if (j >= command.length) throw new Error("unterminated quote");
      word = (word ?? "") + text;
      i = j;
    } else if (c === "\\") {
      word = (word ?? "") + (command[++i] ?? "");
    } else if (c === "#" && word === null) {
      while (i + 1 < command.length && command[i + 1] !== "\n") i++;
    } else if (OPERATORS.includes(c)) {
      if ("<>".includes(c) && /^\d+$/.test(word ?? "")) word = null;
      endWord();
      let op = c;
      while (c !== "\n" && i + 1 < command.length && command[i + 1] !== "\n" && OPERATORS.includes(command[i + 1])) {
        op += command[++i];
      }
      if (op.startsWith("<<")) return tokens;
      tokens.push({ op });
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      if (c === "$") expands = true;
      word = (word ?? "") + c;
    }
  }
  endWord();
  return tokens;
}

function commands(tokens) {
  const result = [];
  let words = [];
  let piped = false;
  let redirect = false;
  for (const token of tokens) {
    if (token.op && /[<>]/.test(token.op)) {
      redirect = true;
    } else if (token.op) {
      if (words.length) result.push({ words, piped });
      words = [];
      piped = token.op === "|" || token.op === "|&";
    } else if (redirect) {
      redirect = false;
    } else {
      words.push(token);
    }
  }
  if (words.length) result.push({ words, piped });
  return result;
}

const expand = (path) => path.replace(/^~(?=\/|$)/, homedir());

function foreign(path, cwd) {
  const full = resolve(cwd, expand(path));
  return full !== cwd && !full.startsWith(cwd + sep);
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function symbols(tokens, cwd) {
  let [name, ...args] = tokens.map((token) => token.word);
  if (name === "git" && args[0] === "grep") [name, args] = ["git grep", args.slice(1)];
  if (!["grep", "rg", "git grep"].includes(name) || args.some((arg) => NOT_CODE.test(arg))) return [];
  if (tokens.some((token) => token.expands)) return [];
  const patterns = [];
  const paths = [];
  let recursive = name !== "grep";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-e" || arg === "--regexp") patterns.push(args[++i] ?? "");
    else if (VALUE_FLAGS.has(arg)) i++;
    else if (arg === "--recursive" || /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(arg)) recursive = true;
    else if (!arg.startsWith("-")) paths.push(arg);
  }
  if (!patterns.length && paths.length) patterns.push(paths.shift());
  if (!recursive || paths.some((path) => foreign(path, cwd))) return [];
  const local = paths.map((path) => resolve(cwd, expand(path)));
  if (local.length === 1 && isFile(local[0])) return [];
  if (name === "git grep" && !local.every((path) => existsSync(path) || path.includes("*"))) return [];
  const names = patterns.flatMap((pattern) =>
    pattern.replace(/\\[b<>]/g, "").replaceAll("\\$", "$").split(/\\?\|/),
  );
  return names.length && names.every((symbol) => SYMBOL.test(symbol)) ? names : [];
}

function decide(command, cwd, denied = new Set()) {
  if (command.includes(ESCAPE) && denied.has(commandKey(command))) return [];
  let parsed;
  try {
    parsed = commands(tokenize(command));
  } catch {
    return [];
  }
  const found = [];
  for (const { words, piped } of parsed) {
    if (words[0].word === "cd" && foreign(words[1]?.word ?? "~", cwd)) return [];
    if (!piped) found.push(...symbols(words, cwd));
  }
  return [...new Set(found)];
}

async function main() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  const input = JSON.parse(text || "{}");
  const command = input.tool_input?.command ?? "";
  const ledger = join(input.scratchpad_dir ?? tmpdir(), `lsp-first-${input.session_id}`);
  const denied = new Set(existsSync(ledger) ? readFileSync(ledger, "utf8").split("\n") : []);
  const names = decide(command, input.cwd ?? process.cwd(), denied);
  if (!names.length) return;
  appendFileSync(ledger, `${commandKey(command)}\n`);
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason(names),
      },
    }),
  );
}

if (process.argv[2] === "--test") {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "lsp-first-")));
  mkdirSync(join(cwd, "src/stores"), { recursive: true });
  mkdirSync(join(cwd, "src/components"), { recursive: true });
  writeFileSync(join(cwd, "src/stores/cart.ts"), "");
  const cases = [
    [String.raw`grep -rln "isLoggedIn\|isGuest" ${cwd}/src/components --include="*.tsx" | grep -v spec`, ["isLoggedIn", "isGuest"]],
    [String.raw`grep -rn 'cartTotal' src --include='*.ts' 2>/dev/null | grep -v -E '\.spec'`, ["cartTotal"]],
    [String.raw`cat a.ts; echo ===; grep -rn -A 6 "PaymentMethod\b" src | head -30`, ["PaymentMethod"]],
    [`cd ${cwd} && rg 'buildQueryKey'`, ["buildQueryKey"]],
    [`grep -rn "API_BASE_URL" src`, ["API_BASE_URL"]],
    [String.raw`grep -rn '\$cartItems' src tests`, ["$cartItems"]],
    [`x=$(grep -rn "cartTotal" src)`, ["cartTotal"]],
    [`grep -rn "cartTotal" src;`, ["cartTotal"]],
    [`git grep -n 'API_BASE_URL' -- src '*.tsx'`, ["API_BASE_URL"]],
    [`rg 'buildQueryKey' ${ESCAPE}`, ["buildQueryKey"]],
    [`grep -n "cartTotal" src/components/cart.tsx`, []],
    [`grep -rn "loading" src`, []],
    [String.raw`grep -rn "useStore(\$cartItems)" src`, []],
    [`grep -rn "cartTotal" node_modules/some-lib`, []],
    [`cd ~/other && grep -rn 'cartTotal' .`, []],
    [`grep -rn "cartTotal" ../other`, []],
    [`grep -rn "cartTotal" src --include="*.md"`, []],
    [`pnpm test 2>&1 | grep -r failedTests`, []],
    [String.raw`grep -rn "\$cartItems\b" src/stores/cart.ts`, []],
    [`git grep -n "API_BASE_URL" HEAD~3 -- src`, []],
    [`python3 - <<'EOF'\ngrep -rn cartTotal src\nEOF`, []],
    [`grep -rn "cartTotal src`, []],
    [`for d in cartTotal cartItems; do grep -rl "$d" src; done`, []],
    [`grep -rn $name src`, []],
  ];
  for (const [command, expected] of cases) assert.deepEqual(decide(command, cwd), expected, command);
  const denied = new Set([commandKey("rg 'buildQueryKey'")]);
  assert.deepEqual(decide(`rg 'buildQueryKey'  ${ESCAPE}`, cwd, denied), []);
  assert.deepEqual(decide(`rg 'buildQueryKey'`, cwd, denied), ["buildQueryKey"]);
  assert.deepEqual(decide(`rg 'cartTotal' ${ESCAPE}`, cwd, denied), ["cartTotal"]);
  console.log("ok");
} else {
  // fail open: a broken hook must not get in the way
  main().catch((error) => console.error(`lsp-first: ${error.message}`));
}
