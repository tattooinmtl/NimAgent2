// Regression suite for the tolerant text-protocol tool-call parser.
// Run: node tests/toolcalls.test.mjs

import { parseTextToolCalls, buildParamRegistry, stripToolCallText, hasToolIntent } from "../src/core/toolcalls.mjs";
import { tools } from "../src/tools/index.mjs";

const reg = buildParamRegistry(tools);
let pass = 0, fail = 0;

function check(label, content, expected) {
  const calls = parseTextToolCalls(content, reg);
  const got = calls.map((c) => ({ name: c.function.name, args: JSON.parse(c.function.arguments) }));
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else {
    fail++;
    console.log(`  ✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    got:      ${JSON.stringify(got)}`);
  }
}

function checkBool(label, actual) {
  if (actual) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`); }
}

// 1. Real-world GLM hybrid: unclosed tool_call, bare <path> key, stray </function>
check("hybrid unclosed sample",
  `Inspecting now.<tool_call>list_dir<path>.nimagent</parameter>\n<parameter=recursive>true</parameter>\n</function>`,
  [{ name: "list_dir", args: { path: ".nimagent", recursive: true } }]);

// 2. Canonical instructed format
check("canonical format",
  `<tool_call>\n<function=read_file>\n<parameter=path>src/index.js</parameter>\n<parameter=limit>100</parameter>\n</function>\n</tool_call>`,
  [{ name: "read_file", args: { path: "src/index.js", limit: 100 } }]);

// 3. GLM trained format (arg_key / arg_value), unclosed envelope
check("GLM arg_key/arg_value unclosed",
  `<tool_call>search\n<arg_key>pattern</arg_key>\n<arg_value>TODO</arg_value>\n<arg_key>case_insensitive</arg_key>\n<arg_value>true</arg_value>`,
  [{ name: "search", args: { pattern: "TODO", case_insensitive: true } }]);

// 4. Qwen JSON format
check("Qwen JSON",
  `<tool_call>\n{"name": "run_shell", "arguments": {"command": "npm test", "timeout_ms": 60000}}\n</tool_call>`,
  [{ name: "run_shell", args: { command: "npm test", timeout_ms: 60000 } }]);

// 5. Bare <function=> without tool_call wrapper
check("bare function block",
  `<function=git_status>\n</function>`,
  [{ name: "git_status", args: {} }]);

// 6. Legacy JSON body inside function tag
check("JSON body in function",
  `<tool_call>\n<function=list_dir>\n{"path": "src"}\n</function>\n</tool_call>`,
  [{ name: "list_dir", args: { path: "src" } }]);

// 7. Multiple calls
check("two calls",
  `<tool_call><function=git_status></function></tool_call>\n<tool_call><function=list_dir><parameter=path>.</parameter></function></tool_call>`,
  [{ name: "git_status", args: {} }, { name: "list_dir", args: { path: "." } }]);

// 8. write_file whose content IS a JSON object — must stay a string
check("JSON content stays string",
  `<tool_call>\n<function=write_file>\n<parameter=path>cfg.json</parameter>\n<parameter=content>{"a": 1}</parameter>\n</function>\n</tool_call>`,
  [{ name: "write_file", args: { path: "cfg.json", content: '{"a": 1}' } }]);

// 9. HTML tags inside a string value survive
check("HTML inside value",
  `<tool_call><function=edit_file><parameter=path>a.html</parameter><parameter=old_string><div>x</div></parameter><parameter=new_string><div>y</div></parameter></function></tool_call>`,
  [{ name: "edit_file", args: { path: "a.html", old_string: "<div>x</div>", new_string: "<div>y</div>" } }]);

// 10. think block stripped before parsing
check("think stripped",
  `<think>plan first</think><tool_call><function=list_dir><parameter=path>.</parameter></function></tool_call>`,
  [{ name: "list_dir", args: { path: "." } }]);

// 11. No tool call — plain answer
check("plain text", "The bug is in line 42.", []);

// 12. invoke style
check("invoke style",
  `<tool_call><invoke name="read_file"><parameter=path>x.js</parameter></invoke></tool_call>`,
  [{ name: "read_file", args: { path: "x.js" } }]);

checkBool("intent detect", hasToolIntent("<tool_call>garbage") === true);
checkBool("intent negative", hasToolIntent("normal text") === false);
checkBool("strip removes closed + unclosed blocks",
  stripToolCallText(`Before.<tool_call>x</tool_call>After.<tool_call>unclosed...`) === "Before.After.");

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
