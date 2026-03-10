/**
 * jCodeMunch Indexer Extension
 *
 * Automatically indexes the project folder on Pi startup using jcodemunch-mcp's
 * `index_folder` command, then watches for file changes and triggers incremental
 * re-indexes. Index status is displayed in the Pi footer via setStatus().
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { dirname, basename, join } from "path";
import { fileURLToPath } from "url";

// Supported source extensions (mirrors jcodemunch-mcp's language support)
const SOURCE_EXTENSIONS = new Set([
	".py",
	".js",
	".jsx",
	".ts",
	".tsx",
	".go",
	".rs",
	".java",
	".php",
	".dart",
	".cs",
	".c",
	".cpp",
	".cc",
	".cxx",
	".hpp",
	".hh",
	".hxx",
	".h",
	".ex",
	".exs",
	".rb",
	".rake",
	".sql",
	".sh",
]);

const STATUS_KEY = "jcodemunch";
const DEBOUNCE_MS = 2000;

interface IndexResult {
	success: boolean;
	message?: string;
	error?: string;
	repo?: string;
	file_count?: number;
	symbol_count?: number;
	changed?: number;
	new?: number;
	deleted?: number;
	duration_seconds?: number;
	discovery_skip_counts?: Record<string, number>;
	no_symbols_count?: number;
	no_symbols_files?: string[];
	languages?: Record<string, number>;
}

export default function (pi: ExtensionAPI) {
	let watcher: fs.FSWatcher | null = null;
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	let indexing = false;
	let projectDir = "";
	let pythonPath = "";
	let lastFileCount = 0;
	let lastSymbolCount = 0;
	let lastError: string | null = null;

	/**
	 * Run jcodemunch index_folder via the installed Python package.
	 * Also queries list_repos to get the definitive file_count (not always
	 * returned in incremental results).
	 */
	async function runIndex(incremental: boolean): Promise<IndexResult> {
		const script = `
import json, sys
from jcodemunch_mcp.tools.index_folder import index_folder
from jcodemunch_mcp.tools.list_repos import list_repos
result = index_folder(
    path=${JSON.stringify(projectDir)},
    use_ai_summaries=False,
    incremental=${incremental ? "True" : "False"}
)
# If file_count is missing (incremental mode), look it up from the repo list
if "file_count" not in result and result.get("success") and result.get("repo"):
    repos = list_repos()
    for r in repos.get("repos", []):
        if r.get("repo") == result["repo"]:
            result["file_count"] = r.get("file_count", 0)
            if "symbol_count" not in result:
                result["symbol_count"] = r.get("symbol_count", 0)
            break
print(json.dumps(result))
`;
		const result = await pi.exec(pythonPath, ["-c", script], { timeout: 120_000 });

		if (result.code !== 0) {
			const errMsg = (result.stderr || result.stdout || "Unknown error").trim();
			throw new Error(errMsg);
		}

		// Parse the last line of stdout (in case of warnings on earlier lines)
		const lines = result.stdout.trim().split("\n");
		const jsonLine = lines[lines.length - 1];
		return JSON.parse(jsonLine) as IndexResult;
	}

	/**
	 * Update the footer status display.
	 */
	function updateStatus(ctx: ExtensionContext, message: string, style: "info" | "error" | "success" = "info") {
		const theme = ctx.ui.theme;
		const prefix = theme.fg("accent", "⚡");
		let styled: string;
		switch (style) {
			case "error":
				styled = theme.fg("error", message);
				break;
			case "success":
				styled = theme.fg("success", message);
				break;
			default:
				styled = theme.fg("dim", message);
		}
		ctx.ui.setStatus(STATUS_KEY, `${prefix} ${styled}`);
	}

	/**
	 * Perform indexing and update the footer.
	 */
	async function performIndex(ctx: ExtensionContext, incremental: boolean) {
		if (indexing) return;
		indexing = true;

		const label = incremental ? "Updating" : "Indexing";
		updateStatus(ctx, `${label} project...`);

		try {
			const result = await runIndex(incremental);

			if (!result.success) {
				lastError = result.error || result.message || "Index failed";
				updateStatus(ctx, `Index error: ${lastError}`, "error");
				return;
			}

			lastError = null;

			// Update counts from result
			if (result.file_count !== undefined) lastFileCount = result.file_count;
			if (result.symbol_count !== undefined) lastSymbolCount = result.symbol_count;

			// Build status message
			if (incremental && result.message === "No changes detected") {
				updateStatus(ctx, `${lastFileCount} files, ${lastSymbolCount} symbols (up to date)`, "success");
			} else {
				const parts: string[] = [`${lastFileCount} files`, `${lastSymbolCount} symbols`];
				if (incremental) {
					const changes: string[] = [];
					if (result.new) changes.push(`+${result.new}`);
					if (result.deleted) changes.push(`-${result.deleted}`);
					if (result.changed) changes.push(`~${result.changed}`);
					if (changes.length > 0) parts.push(`(${changes.join(", ")})`);
				}
				if (result.duration_seconds !== undefined) {
					parts.push(`in ${result.duration_seconds.toFixed(1)}s`);
				}
				updateStatus(ctx, parts.join(", "), "success");
			}
		} catch (err: unknown) {
			lastError = err.message || String(err);
			// Truncate long error messages for the footer
			const shortErr = lastError?.length > 80 ? lastError?.slice(0, 77) + "..." : lastError;
			updateStatus(ctx, `Index error: ${shortErr}`, "error");
		} finally {
			indexing = false;
		}
	}

	/**
	 * Schedule a debounced incremental re-index after file changes.
	 */
	function scheduleReindex(ctx: ExtensionContext) {
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			debounceTimer = null;
			performIndex(ctx, true);
		}, DEBOUNCE_MS);
	}

	/**
	 * Determine if a changed file is relevant (source code that jcodemunch would index).
	 */
	function isRelevantFile(filename: string): boolean {
		if (!filename) return false;
		// Ignore hidden directories/files, node_modules, .venv, __pycache__, etc.
		const parts = filename.split(path.sep);
		for (const part of parts) {
			if (part.startsWith(".") || part === "node_modules" || part === "__pycache__" || part === ".venv" || part === "dist" || part === "build") {
				return false;
			}
		}
		const ext = path.extname(filename).toLowerCase();
		return SOURCE_EXTENSIONS.has(ext);
	}

	/**
	 * Start watching the project directory for file changes.
	 */
	function startWatcher(ctx: ExtensionContext) {
		if (watcher) return;

		try {
			watcher = fs.watch(projectDir, { recursive: true }, (eventType, filename) => {
				if (filename && isRelevantFile(filename)) {
					scheduleReindex(ctx);
				}
			});

			watcher.on("error", (err) => {
				updateStatus(ctx, `Watcher error: ${err.message}`, "error");
				// Try to restart the watcher after a delay
				stopWatcher();
				setTimeout(() => startWatcher(ctx), 5000);
			});
		} catch (err: unknown) {
			updateStatus(ctx, `Cannot watch: ${err.message}`, "error");
		}
	}

	/**
	 * Stop the file watcher.
	 */
	function stopWatcher() {
		if (watcher) {
			watcher.close();
			watcher = null;
		}
		if (debounceTimer) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}
	}

	/**
	 * Run a Python snippet that prints JSON and return the parsed result.
	 */
	async function runPythonJson(script: string): Promise<string> {
		const result = await pi.exec(pythonPath, ["-c", script], { timeout: 120_000 });
		if (result.code !== 0) {
			const errMsg = (result.stderr || result.stdout || "Unknown error").trim();
			throw new Error(errMsg);
		}
		const lines = result.stdout.trim().split("\n");
		return JSON.parse(lines[lines.length - 1]);
	}

	// --- Commands ---

	pi.registerCommand("list_repos", {
		description: "List all jcodemunch indexed repositories",
		handler: async (_args, ctx) => {
			try {
				const data = await runPythonJson(`
import json
from jcodemunch_mcp.tools.list_repos import list_repos
print(json.dumps(list_repos()))
`);
				const repos = data.repos ?? [];
				if (repos.length === 0) {
					ctx.ui.notify("No indexed repositories found.", "info");
					return;
				}
				const lines: string[] = [];
				for (const r of repos) {
					lines.push(`• ${r.repo}`);
					if (r.display_name) lines.push(`    display_name : ${r.display_name}`);
					if (r.source_root) lines.push(`    source_root  : ${r.source_root}`);
					lines.push(`    file_count   : ${r.file_count ?? "?"}`);
					lines.push(`    symbol_count : ${r.symbol_count ?? "?"}`);
					lines.push(`    languages    : ${JSON.stringify(r.languages ?? {})}`);
					lines.push(`    indexed_at   : ${r.indexed_at ?? "?"}`);
					lines.push(`    index_version: ${r.index_version ?? "?"}`);
				}
				lines.push(`\n${repos.length} repo(s), query took ${data._meta?.timing_ms ?? "?"}ms`);
				ctx.ui.notify(lines.join("\n"), "info");
			} catch (err: unknown) {
				ctx.ui.notify(`list_repos failed: ${err.message}`, "error");
			}
		},
	});

	pi.registerCommand("invalidate_cache", {
		description: "Delete the jcodemunch index for a repository (forces full re-index)",
		handler: async (args, ctx) => {
			const repo = args?.trim();
			if (!repo) {
				ctx.ui.notify("Usage: /invalidate_cache <repo>", "error");
				return;
			}
			try {
				const data = await runPythonJson(`
import json
from jcodemunch_mcp.tools.invalidate_cache import invalidate_cache
print(json.dumps(invalidate_cache(repo=${JSON.stringify(repo)})))
`);
				if (data.success) {
					ctx.ui.notify(`Cache invalidated for ${repo}.`, "info");
				} else {
					ctx.ui.notify(`invalidate_cache: ${data.error ?? data.message ?? "unknown error"}`, "error");
				}
			} catch (err: unknown) {
				ctx.ui.notify(`invalidate_cache failed: ${err.message}`, "error");
			}
		},
	});

	pi.registerCommand("get_repo_outline", {
		description: "Show high-level overview of an indexed repository (dirs, languages, symbol counts)",
		handler: async (args, ctx) => {
			const repo = args?.trim();
			if (!repo) {
				ctx.ui.notify("Usage: /get_repo_outline <repo>", "error");
				return;
			}
			try {
				const data = await runPythonJson(`
import json
from jcodemunch_mcp.tools.get_repo_outline import get_repo_outline
print(json.dumps(get_repo_outline(repo=${JSON.stringify(repo)})))
`);
				if (data.error) {
					ctx.ui.notify(`get_repo_outline: ${data.error}`, "error");
					return;
				}
				const parts: string[] = [];
				if (data.repo) parts.push(`Repo: ${data.repo}`);
				if (data.indexed_at) parts.push(`Indexed at: ${data.indexed_at}`);
				if (data.file_count !== null) parts.push(`Files: ${data.file_count}`);
				if (data.symbol_count !== null) parts.push(`Symbols: ${data.symbol_count}`);
				if (data.languages) {
					const langs = Object.entries(data.languages)
						.map(([lang, count]) => `  ${lang}: ${count}`)
						.join("\n");
					parts.push(`Languages:\n${langs}`);
				}
				if (data.symbol_kinds) {
					const kinds = Object.entries(data.symbol_kinds)
						.map(([kind, count]) => `  ${kind}: ${count}`)
						.join("\n");
					parts.push(`Symbol kinds:\n${kinds}`);
				}
				if (data.directories) {
					const dirs = Object.entries(data.directories)
						.map(([dir, count]) => `  ${dir} (${count} files)`)
						.join("\n");
					parts.push(`Directories:\n${dirs}`);
				}
				if (data.staleness_warning) {
					parts.push(`⚠️  ${data.staleness_warning}`);
				}
				if (data._meta) {
					const m = data._meta;
					const metaLines = [`  timing: ${m.timing_ms ?? "?"}ms`];
					if (m.tokens_saved !== null) metaLines.push(`  tokens saved: ${m.tokens_saved}`);
					if (m.total_tokens_saved !== null) metaLines.push(`  total tokens saved: ${m.total_tokens_saved}`);
					if (m.cost_avoided_usd !== null) metaLines.push(`  cost avoided: $${m.cost_avoided_usd}`);
					if (m.total_cost_avoided_usd !== null) metaLines.push(`  total cost avoided: $${m.total_cost_avoided_usd}`);
					parts.push(`Meta:\n${metaLines.join("\n")}`);
				}
				ctx.ui.notify(parts.join("\n"), "info");
			} catch (err: unknown) {
				ctx.ui.notify(`get_repo_outline failed: ${err.message}`, "error");
			}
		},
	});

	// --- Lifecycle hooks ---

	pi.on("session_start", async (_event, ctx) => {
		projectDir = ctx.cwd;
		pythonPath = path.join(`${process.env.HOME}`, ".venv", "bin", "python");

		// Verify python + jcodemunch are available
		try {
			const check = await pi.exec(pythonPath, ["-c", "import jcodemunch_mcp; print('ok')"], { timeout: 10_000 });
			if (check.code !== 0) {
				updateStatus(ctx, "jcodemunch-mcp not installed in .venv", "error");
				return;
			}
		} catch {
			updateStatus(ctx, "Python venv not found", "error");
			return;
		}

		// Run initial full index (non-incremental first time, incremental if cache exists)
		await performIndex(ctx, true);

		// Start watching for changes
		startWatcher(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopWatcher();
	});

	pi.on("session_switch", async (_event, ctx) => {
		// Re-display status after session switch
		if (lastError) {
			updateStatus(ctx, `Index error: ${lastError}`, "error");
		} else if (lastFileCount > 0) {
			updateStatus(ctx, `${lastFileCount} files, ${lastSymbolCount} symbols (up to date)`, "success");
		}
	});

	// Also trigger re-index after tool_result for write/edit tools (catches agent-made changes)
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName === "write" || event.toolName === "edit") {
			scheduleReindex(ctx);
		}
	});

	// -----------------------------------------------------------------------
	// Tools
	// -----------------------------------------------------------------------

	pi.registerTool({
		name: "search_symbols",
		label: "Search Symbols",
		description:
			"Search for code symbols (functions, classes, methods, constants, types) across the indexed project. Returns matching symbols with signatures and summaries. Use this before reading entire files to find the exact code you need.",
		promptSnippet:
			"Search for code symbols by name, kind, or language. More efficient than reading entire files.",
		promptGuidelines: [
			"Before reading entire files, use search_symbols to find specific functions, classes, or methods.",
			"Use the symbol IDs from search results with get_symbol to retrieve full source code.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query (matches symbol names, signatures, summaries)" }),
			kind: Type.Optional(
				Type.String({
					description: "Filter by symbol kind: function, class, method, constant, type",
				}),
			),
			language: Type.Optional(
				Type.String({
					description: "Filter by language: python, javascript, typescript, go, rust, java, php, dart, csharp, c",
				}),
			),
			file_pattern: Type.Optional(
				Type.String({ description: "Glob pattern to filter files (e.g., 'src/**/*.ts')" }),
			),
			max_results: Type.Optional(
				Type.Number({ description: "Maximum results to return (default: 20, max: 100)" }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const repo = repoId(ctx.cwd);
			const args = ["search_symbols", repo, params.query];

			if (params.kind) {
				args.push("--kind", params.kind);
			}
			if (params.language) {
				args.push("--language", params.language);
			}
			if (params.file_pattern) {
				args.push("--file-pattern", params.file_pattern);
			}
			if (params.max_results !== undefined) {
				args.push("--max-results", String(params.max_results));
			}

			const result = await callCli(pi, args, { signal: signal ?? undefined, cwd: ctx.cwd });

			if (result.error) {
				throw new Error(result.error as string);
			}

			const results = (result.results ?? []) as Array<Record<string, unknown>>;
			if (results.length === 0) {
				return {
					content: [{ type: "text", text: `No symbols found matching "${params.query}".` }],
					details: result,
				};
			}

			const lines = results.map((sym) => {
				const parts = [
					`${sym.kind} ${sym.name}`,
					`  file: ${sym.file}:${sym.line}`,
					`  id: ${sym.id}`,
					`  signature: ${sym.signature}`,
				];
				if (sym.summary) {
					parts.push(`  summary: ${sym.summary}`);
				}
				return parts.join("\n");
			});

			const header = `Found ${results.length} symbol(s) matching "${params.query}":`;
			const text = [header, "", ...lines].join("\n");

			return {
				content: [{ type: "text", text }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "get_symbol",
		label: "Get Symbol",
		description:
			"Retrieve the full source code of a specific symbol by its ID. Use after search_symbols or file_outline to read exact implementations without loading entire files.",
		promptSnippet: "Retrieve full source of a symbol by ID. O(1) byte-offset seeking.",
		promptGuidelines: [
			"Use get_symbol to read exact function/class implementations instead of reading full files.",
			"Symbol IDs come from search_symbols or file_outline results.",
		],
		parameters: Type.Object({
			symbol_id: Type.String({
				description:
					"Symbol ID in the format file_path::qualified_name#kind (from search_symbols or file_outline)",
			}),
			context_lines: Type.Optional(
				Type.Number({
					description: "Number of surrounding lines to include for context (default: 0, max: 50)",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const repo = repoId(ctx.cwd);
			const args = ["get_symbol", repo, params.symbol_id];

			if (params.context_lines !== undefined) {
				args.push("--context-lines", String(params.context_lines));
			}

			const result = await callCli(pi, args, { signal: signal ?? undefined, cwd: ctx.cwd });

			if (result.error) {
				throw new Error(result.error as string);
			}

			const parts: string[] = [];

			// Header
			parts.push(`${result.kind} ${result.name} (${result.file}:${result.line}-${result.end_line})`);
			parts.push(`ID: ${result.id}`);
			if (result.signature) {
				parts.push(`Signature: ${result.signature}`);
			}
			parts.push("");

			// Context before
			if (result.context_before) {
				parts.push("--- context before ---");
				parts.push(result.context_before as string);
				parts.push("--- symbol source ---");
			}

			// Source
			parts.push(result.source as string);

			// Context after
			if (result.context_after) {
				parts.push("--- context after ---");
				parts.push(result.context_after as string);
			}

			return {
				content: [{ type: "text", text: parts.join("\n") }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "get_symbols",
		label: "Get Symbols (batch)",
		description:
			"Batch retrieve full source code of multiple symbols by their IDs. More efficient than calling get_symbol repeatedly.",
		promptSnippet: "Batch retrieve source of multiple symbols in one call.",
		promptGuidelines: [
			"Use get_symbols when you need to read multiple related symbols (e.g., all methods of a class).",
		],
		parameters: Type.Object({
			symbol_ids: Type.Array(Type.String(), {
				description: "List of symbol IDs to retrieve",
			}),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const repo = repoId(ctx.cwd);
			const args = ["get_symbols", repo, ...params.symbol_ids];

			const result = await callCli(pi, args, { signal: signal ?? undefined, cwd: ctx.cwd });

			if (result.error) {
				throw new Error(result.error as string);
			}

			const symbols = (result.symbols ?? []) as Array<Record<string, unknown>>;
			const errors = (result.errors ?? []) as Array<Record<string, unknown>>;

			const parts: string[] = [];

			for (const sym of symbols) {
				parts.push(`--- ${sym.kind} ${sym.name} (${sym.file}:${sym.line}-${sym.end_line}) ---`);
				parts.push(`ID: ${sym.id}`);
				parts.push("");
				parts.push(sym.source as string);
				parts.push("");
			}

			if (errors.length > 0) {
				parts.push("--- errors ---");
				for (const err of errors) {
					parts.push(`${err.id}: ${err.error}`);
				}
			}

			return {
				content: [{ type: "text", text: parts.join("\n") }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "file_outline",
		label: "File Outline",
		description:
			"Get the symbol hierarchy for a file: all functions, classes, methods with their signatures. Does not include source code. Use to understand a file's API surface before reading it.",
		promptSnippet: "Get symbol hierarchy for a file (signatures, no source). Use before reading a file.",
		promptGuidelines: [
			"Use file_outline to understand a file's API surface before reading the full file.",
			"Use the symbol IDs from the outline with get_symbol to retrieve specific implementations.",
		],
		parameters: Type.Object({
			file_path: Type.String({
				description: "Path to the file relative to the project root (e.g., 'src/main.py')",
			}),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const repo = repoId(ctx.cwd);
			const args = ["file_outline", repo, params.file_path];

			const result = await callCli(pi, args, { signal: signal ?? undefined, cwd: ctx.cwd });

			if (result.error) {
				throw new Error(result.error as string);
			}

			const symbols = (result.symbols ?? []) as Array<Record<string, unknown>>;

			if (symbols.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No symbols found in ${params.file_path}. The file may not contain supported language constructs, or the project may need re-indexing (/reindex).`,
						},
					],
					details: result,
				};
			}

			function formatSymbol(sym: Record<string, unknown>, indent: number): string[] {
				const prefix = "  ".repeat(indent);
				const lines = [
					`${prefix}${sym.kind} ${sym.name} (line ${sym.line})`,
					`${prefix}  id: ${sym.id}`,
					`${prefix}  signature: ${sym.signature}`,
				];
				if (sym.summary) {
					lines.push(`${prefix}  summary: ${sym.summary}`);
				}
				const children = (sym.children ?? []) as Array<Record<string, unknown>>;
				for (const child of children) {
					lines.push(...formatSymbol(child, indent + 1));
				}
				return lines;
			}

			const header = `${params.file_path} (${result.language ?? "unknown"}, ${symbols.length} top-level symbols):`;
			const body = symbols.flatMap((sym) => formatSymbol(sym, 0));

			return {
				content: [{ type: "text", text: [header, "", ...body].join("\n") }],
				details: result,
			};
		},
	});

	// ---------------------------------------------------------------------------
	// Helpers
	// ---------------------------------------------------------------------------

	/** Resolve the path to cli.py relative to this extension file. */
	function cliPath(): string {
		const thisFile = fileURLToPath(import.meta.url);
		return join(dirname(thisFile), "cli.py");
	}

	/** The repo identifier jcodemunch uses for local folders: "local/<dirname>". */
	function repoId(cwd: string): string {
		return `local/${basename(cwd)}`;
	}

	interface CallResult {
		success?: boolean;
		error?: string;
		[key: string]: unknown;
	}

	/**
	 * Call the jcodemunch CLI bridge and parse the JSON response.
	 * Uses pi.exec() so abort signals and timeouts are handled.
	 */
	async function callCli(
		pi: ExtensionAPI,
		args: string[],
		options?: { signal?: AbortSignal; timeout?: number; cwd?: string },
	): Promise<CallResult> {
		const result = await pi.exec("python3", [cliPath(), ...args], {
			signal: options?.signal,
			timeout: options?.timeout ?? 120_000,
			cwd: options?.cwd,
		});

		if (result.code !== 0) {
			// Try to parse stderr or stdout for a JSON error from the CLI
			const output = result.stdout || result.stderr;
			try {
				const parsed = JSON.parse(output);
				if (parsed.error) {
					return parsed as CallResult;
				}
			} catch {
				// Not JSON
			}
			return { error: `CLI exited with code ${result.code}: ${output.slice(0, 500)}` };
		}

		try {
			return JSON.parse(result.stdout) as CallResult;
		} catch {
			return { error: `Invalid JSON from CLI: ${result.stdout.slice(0, 500)}` };
		}
	}
}
