import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLspTool, createLspToolDefinition } from "../src/core/tools/lsp.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
describe("LSP tool", () => {
	it("exposes the documented operations and server configuration", () => {
		const options = { command: "example-language-server", args: ["--stdio"], languageId: "typescript" };
		const definition = createLspToolDefinition("/workspace", options);
		const tool = createLspTool("/workspace", options);

		expect(definition.name).toBe("lsp");
		expect(definition.parameters.properties.operation.anyOf.map((item: { const: string }) => item.const)).toEqual([
			"definition",
			"references",
			"diagnostics",
		]);
		expect(tool.name).toBe("lsp");
	});

	it("starts an LSP server over stdio and returns published diagnostics", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "noushi-lsp-"));
		tempDirs.push(cwd);
		await writeFile(path.join(cwd, "sample.ts"), "const value = 1;\n");
		const server = `let input=Buffer.alloc(0);process.stdin.on('data',chunk=>{input=Buffer.concat([input,chunk]);for(;;){const i=input.indexOf('\\r\\n\\r\\n');if(i<0)return;const m=Number(input.toString('ascii',0,i).match(/Content-Length: (\\d+)/i)?.[1]);if(input.length<i+4+m)return;const msg=JSON.parse(input.toString('utf8',i+4,i+4+m));input=input.subarray(i+4+m);const send=x=>{const b=Buffer.from(JSON.stringify(x));process.stdout.write('Content-Length: '+b.length+'\\r\\n\\r\\n');process.stdout.write(b)};if(msg.method==='initialize')send({jsonrpc:'2.0',id:msg.id,result:{capabilities:{}}});if(msg.method==='textDocument/didOpen')send({jsonrpc:'2.0',method:'textDocument/publishDiagnostics',params:{uri:msg.params.textDocument.uri,diagnostics:[{message:'sample diagnostic'}]}});if(msg.method==='textDocument/definition'||msg.method==='textDocument/references')send({jsonrpc:'2.0',id:msg.id,result:[]});if(msg.method==='shutdown')send({jsonrpc:'2.0',id:msg.id,result:null});if(msg.method==='exit')process.exit(0)}});`;
		const definition = createLspToolDefinition(cwd, {
			command: process.execPath,
			args: ["-e", server],
			languageId: "typescript",
		});
		const ctx = { cwd } as Parameters<typeof definition.execute>[4];
		const result = await definition.execute(
			"lsp-test",
			{ operation: "diagnostics", file: "sample.ts" },
			undefined,
			undefined,
			ctx,
		);
		expect(result.content).toEqual([{ type: "text", text: '[\n  {\n    "message": "sample diagnostic"\n  }\n]' }]);
	});
});
