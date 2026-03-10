# jCodeMunch MCP Server Reference

**Package:** `jcodemunch-mcp` v1.2.8  
**Purpose:** Token-efficient MCP server for source code exploration via tree-sitter AST parsing  
**Author:** J. Gravelle  
**License:** Dual-use (free for non-commercial; commercial license required for business use)

---

## Overview

jCodeMunch indexes a codebase once using tree-sitter AST parsing, then exposes 12 MCP tools that let agents **discover and retrieve code by symbol** instead of brute-reading entire files. It implements the **jMRI-Full** specification for structured retrieval.

Every symbol stores: signature, kind, qualified name, one-line summary, and byte offsets into the original file. Full source is retrieved on demand via O(1) byte-offset seeking.

**Token savings claim:** up to 99% reduction in code-reading tokens (e.g., ~80% fewer tokens on real-world benchmarks).

---

## Tools (12)

### 1. `index_repo`
> Index a GitHub repository's source code. Fetches files, parses ASTs, extracts symbols, and saves to local storage.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `url` | string | ✅ | — | GitHub repository URL or `owner/repo` string |
| `use_ai_summaries` | boolean | — | `true` | Use AI to generate symbol summaries (requires `ANTHROPIC_API_KEY` or `GOOGLE_API_KEY`) |
| `extra_ignore_patterns` | string[] | — | — | Additional gitignore-style patterns to exclude from indexing |
| `incremental` | boolean | — | `true` | When true and an existing index exists, only re-index changed files |

### 2. `index_folder`
> Index a local folder containing source code. Response includes `discovery_skip_counts`, `no_symbols_count`/`no_symbols_files` for diagnosing missing files.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | ✅ | — | Path to local folder (absolute or relative, supports `~`) |
| `use_ai_summaries` | boolean | — | `true` | Use AI to generate symbol summaries |
| `extra_ignore_patterns` | string[] | — | — | Additional gitignore-style patterns to exclude |
| `follow_symlinks` | boolean | — | `false` | Whether to follow symlinks (default false for security) |
| `incremental` | boolean | — | `true` | Only re-index changed files when an existing index exists |

### 3. `list_repos`
> List all indexed repositories.

No parameters.

### 4. `get_file_tree`
> Get the file tree of an indexed repository, optionally filtered by path prefix.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `repo` | string | ✅ | — | Repository identifier (`owner/repo` or just repo name) |
| `path_prefix` | string | — | `""` | Optional path prefix to filter (e.g., `src/utils`) |
| `include_summaries` | boolean | — | `false` | Include file-level summaries in the tree nodes |

### 5. `get_file_outline`
> Get all symbols (functions, classes, methods) in a file with signatures and summaries.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `repo` | string | ✅ | — | Repository identifier |
| `file_path` | string | ✅ | — | Path to the file within the repository (e.g., `src/main.py`) |

### 6. `get_file_content`
> Get cached source for a file, optionally sliced to a line range.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `repo` | string | ✅ | — | Repository identifier |
| `file_path` | string | ✅ | — | Path to the file within the repository |
| `start_line` | integer | — | — | Optional 1-based start line (inclusive) |
| `end_line` | integer | — | — | Optional 1-based end line (inclusive) |

### 7. `get_symbol`
> Get the full source code of a specific symbol. Use after identifying relevant symbols via `get_file_outline` or `search_symbols`.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `repo` | string | ✅ | — | Repository identifier |
| `symbol_id` | string | ✅ | — | Symbol ID from `get_file_outline` or `search_symbols` |
| `verify` | boolean | — | `false` | Verify content hash matches stored hash (detects source drift) |
| `context_lines` | integer | — | `0` | Number of lines before/after symbol to include for context |

### 8. `get_symbols`
> Get full source code of multiple symbols in one call. Efficient for loading related symbols.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `repo` | string | ✅ | — | Repository identifier |
| `symbol_ids` | string[] | ✅ | — | List of symbol IDs to retrieve |

### 9. `search_symbols`
> Search for symbols matching a query across the entire indexed repository. Returns matches with signatures and summaries.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `repo` | string | ✅ | — | Repository identifier |
| `query` | string | ✅ | — | Search query (matches symbol names, signatures, summaries, docstrings) |
| `kind` | string | — | — | Filter by symbol kind: `function`, `class`, `method`, `constant`, `type` |
| `file_pattern` | string | — | — | Glob pattern to filter files (e.g., `src/**/*.py`) |
| `language` | string | — | — | Filter by language (see supported languages below) |
| `max_results` | integer | — | `10` | Maximum number of results to return |

### 10. `search_text`
> Full-text search across indexed file contents. Useful when symbol search misses (e.g., string literals, comments, config values).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `repo` | string | ✅ | — | Repository identifier |
| `query` | string | ✅ | — | Text to search for (case-insensitive substring match) |
| `file_pattern` | string | — | — | Optional glob pattern to filter files (e.g., `*.py`) |
| `max_results` | integer | — | `20` | Maximum number of matching lines to return |
| `context_lines` | integer | — | `0` | Number of surrounding lines to include before/after each match |

### 11. `get_repo_outline`
> Get a high-level overview of an indexed repository: directories, file counts, language breakdown, symbol counts. Lighter than `get_file_tree`.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `repo` | string | ✅ | — | Repository identifier |

### 12. `invalidate_cache`
> Delete the index and cached files for a repository. Forces a full re-index on next `index_repo` or `index_folder` call.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `repo` | string | ✅ | — | Repository identifier |

---

## Symbol ID Format

```
{file_path}::{qualified_name}#{kind}
```

Examples:
- `src/main.py::UserService.login#method`
- `src/utils.py::authenticate#function`

IDs remain stable across re-indexing when path, qualified name, and kind are unchanged.

---

## `_meta` Envelope

Every tool response includes a `_meta` object with:

| Field | Description |
|-------|-------------|
| `timing_ms` | Execution time in milliseconds |
| `tokens_saved` | Tokens saved in this call |
| `total_tokens_saved` | Cumulative tokens saved across all calls |
| `cost_avoided` | Estimated cost savings per model (e.g., `claude_opus`, `gpt5_latest`) |
| `total_cost_avoided` | Cumulative cost savings across all calls |
| `powered_by` | Attribution string |

Cumulative savings persist to `~/.code-index/_savings.json`.

---

## Supported Languages

| Language | Extensions | Symbol Types |
|----------|-----------|-------------|
| Python | `.py` | function, class, method, constant, type |
| JavaScript | `.js`, `.jsx` | function, class, method, constant |
| TypeScript | `.ts`, `.tsx` | function, class, method, constant, type |
| Go | `.go` | function, method, type, constant |
| Rust | `.rs` | function, type, impl, constant |
| Java | `.java` | method, class, type, constant |
| PHP | `.php` | function, class, method, type, constant |
| Dart | `.dart` | function, class, method, type |
| C# | `.cs` | class, method, type, record |
| C | `.c` | function, type, constant |
| C++ | `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hh`, `.hxx`, `.h`* | function, class, method, type, constant |
| Elixir | `.ex`, `.exs` | class (module/impl), type (protocol/@type/@callback), method, function |
| Ruby | `.rb`, `.rake` | class, type (module), method, function |
| SQL | `.sql` | function (CREATE FUNCTION, CTE, dbt macro/test/materialization), type (CREATE TABLE/VIEW/SCHEMA/INDEX, dbt snapshot) |

\* `.h` is parsed as C++ first, then falls back to C when no C++ symbols are extracted.

---

## Environment Variables

| Variable | Purpose | Required |
|----------|---------|----------|
| `GITHUB_TOKEN` | GitHub API auth (higher rate limits, private repos) | No |
| `ANTHROPIC_API_KEY` | AI summaries via Claude Haiku (takes priority over Gemini) | No |
| `ANTHROPIC_BASE_URL` | Third-party Anthropic-compatible endpoints | No |
| `ANTHROPIC_MODEL` | Model name (default: `claude-haiku-4-5-20251001`) | No |
| `GOOGLE_API_KEY` | AI summaries via Gemini Flash | No |
| `GOOGLE_MODEL` | Model name (default: `gemini-2.5-flash-lite`) | No |
| `OPENAI_API_BASE` | Base URL for local LLMs (e.g., Ollama at `http://localhost:11434/v1`) | No |
| `OPENAI_API_KEY` | API key for local LLMs (default: `local-llm`) | No |
| `OPENAI_MODEL` | Model for local LLMs (default: `qwen3-coder`) | No |
| `OPENAI_TIMEOUT` | Timeout in seconds for local requests (default: `60.0`) | No |
| `OPENAI_BATCH_SIZE` | Symbols per summarization request (default: `10`) | No |
| `OPENAI_CONCURRENCY` | Max parallel batch requests (default: `1`) | No |
| `OPENAI_MAX_TOKENS` | Max output tokens per batch response (default: `500`) | No |
| `CODE_INDEX_PATH` | Custom cache path (default: `~/.code-index/`) | No |
| `JCODEMUNCH_MAX_INDEX_FILES` | Maximum files to index per repo/folder (default: `10000`) | No |
| `JCODEMUNCH_USE_AI_SUMMARIES` | Set to `false`/`0` to disable AI summaries globally | No |
| `JCODEMUNCH_EXTRA_IGNORE_PATTERNS` | Merged with per-call `extra_ignore_patterns` | No |
| `JCODEMUNCH_SHARE_SAVINGS` | Set to `0` to disable anonymous community token savings reporting | No |
| `JCODEMUNCH_LOG_LEVEL` | `DEBUG`, `INFO`, `WARNING`, `ERROR` (default: `WARNING`) | No |
| `JCODEMUNCH_LOG_FILE` | Path to log file (defaults to stderr; use a file to avoid corrupting MCP stdio) | No |

---

## Architecture Notes

- **Storage:** JSON index + raw files stored locally at `~/.code-index/` (configurable via `CODE_INDEX_PATH`)
- **Parsing:** tree-sitter AST extraction across 14+ languages
- **Security:** Built-in path traversal prevention, symlink escape protection, secret file exclusion (`.env`, `*.pem`, etc.), binary detection, configurable file size limits
- **Transport:** MCP stdio server (compatible with Claude Desktop, Claude Code, VS Code, Google Antigravity, etc.)
- **Incremental indexing:** Default behavior — only re-indexes changed files on subsequent calls
- **AI summaries:** Optional; supports Anthropic (Claude Haiku), Google (Gemini Flash), and local LLMs (Ollama/LM Studio via OpenAI-compatible API)
- **Community savings meter:** Anonymous token savings delta reported to `j.gravelle.us` (opt-out via `JCODEMUNCH_SHARE_SAVINGS=0`)

---

## Typical Agent Workflow

1. **`index_repo`** or **`index_folder`** — index the codebase once
2. **`get_repo_outline`** — understand the high-level structure
3. **`search_symbols`** — find relevant symbols by name/kind/language
4. **`get_file_outline`** — see all symbols in a specific file
5. **`get_symbol`** / **`get_symbols`** — retrieve exact source code
6. **`search_text`** — fallback for non-symbol queries (strings, comments, config)
7. **`get_file_content`** — retrieve raw file content with optional line range

---

## Not Intended For

- LSP diagnostics or completions
- Editing workflows
- Real-time file watching
- Cross-repository global indexing
- Semantic program analysis
