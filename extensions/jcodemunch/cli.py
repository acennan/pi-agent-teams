#!/usr/bin/env python3
"""Thin CLI wrapper around jcodemunch-mcp for use by pi extensions.

Avoids the MCP protocol entirely. Each subcommand calls the underlying
jcodemunch tool function directly and prints JSON to stdout.

Usage:
    python cli.py index_folder /path/to/project [--incremental]
    python cli.py search_symbols <repo> <query> [--kind ...] [--language ...] [--file-pattern ...] [--max-results N]
    python cli.py get_symbol <repo> <symbol_id> [--context-lines N]
    python cli.py get_symbols <repo> <id1> <id2> ...
    python cli.py file_outline <repo> <file_path>
    python cli.py repo_outline <repo>
    python cli.py list_repos
    python cli.py invalidate <repo>
"""

import json
import sys


def _print_json(data: dict) -> None:
    json.dump(data, sys.stdout, indent=2)
    sys.stdout.write("\n")
    sys.stdout.flush()


def _error(msg: str) -> None:
    _print_json({"error": msg})
    sys.exit(1)


def cmd_index_folder(args: list[str]) -> None:
    if not args:
        _error("Usage: index_folder <path> [--incremental] [--no-ai]")

    from jcodemunch_mcp.tools.index_folder import index_folder

    path = args[0]
    incremental = "--incremental" in args
    use_ai = "--no-ai" not in args

    result = index_folder(
        path=path,
        use_ai_summaries=use_ai,
        incremental=incremental,
    )
    _print_json(result)


def cmd_search_symbols(args: list[str]) -> None:
    if len(args) < 2:
        _error("Usage: search_symbols <repo> <query> [--kind K] [--language L] [--file-pattern P] [--max-results N]")

    from jcodemunch_mcp.tools.search_symbols import search_symbols

    repo = args[0]
    query = args[1]

    kind = None
    language = None
    file_pattern = None
    max_results = 20

    i = 2
    while i < len(args):
        if args[i] == "--kind" and i + 1 < len(args):
            kind = args[i + 1]
            i += 2
        elif args[i] == "--language" and i + 1 < len(args):
            language = args[i + 1]
            i += 2
        elif args[i] == "--file-pattern" and i + 1 < len(args):
            file_pattern = args[i + 1]
            i += 2
        elif args[i] == "--max-results" and i + 1 < len(args):
            max_results = int(args[i + 1])
            i += 2
        else:
            i += 1

    result = search_symbols(
        repo=repo,
        query=query,
        kind=kind,
        file_pattern=file_pattern,
        language=language,
        max_results=max_results,
    )
    _print_json(result)


def cmd_get_symbol(args: list[str]) -> None:
    if len(args) < 2:
        _error("Usage: get_symbol <repo> <symbol_id> [--context-lines N]")

    from jcodemunch_mcp.tools.get_symbol import get_symbol

    repo = args[0]
    symbol_id = args[1]
    context_lines = 0

    i = 2
    while i < len(args):
        if args[i] == "--context-lines" and i + 1 < len(args):
            context_lines = int(args[i + 1])
            i += 2
        else:
            i += 1

    result = get_symbol(
        repo=repo,
        symbol_id=symbol_id,
        context_lines=context_lines,
    )
    _print_json(result)


def cmd_get_symbols(args: list[str]) -> None:
    if len(args) < 2:
        _error("Usage: get_symbols <repo> <id1> [id2] ...")

    from jcodemunch_mcp.tools.get_symbol import get_symbols

    repo = args[0]
    symbol_ids = args[1:]

    result = get_symbols(repo=repo, symbol_ids=symbol_ids)
    _print_json(result)


def cmd_file_outline(args: list[str]) -> None:
    if len(args) < 2:
        _error("Usage: file_outline <repo> <file_path>")

    from jcodemunch_mcp.tools.get_file_outline import get_file_outline

    result = get_file_outline(repo=args[0], file_path=args[1])
    _print_json(result)


def cmd_repo_outline(args: list[str]) -> None:
    if not args:
        _error("Usage: repo_outline <repo>")

    from jcodemunch_mcp.tools.get_repo_outline import get_repo_outline

    result = get_repo_outline(repo=args[0])
    _print_json(result)


def cmd_list_repos(args: list[str]) -> None:
    from jcodemunch_mcp.tools.list_repos import list_repos

    result = list_repos()
    _print_json(result)


def cmd_invalidate(args: list[str]) -> None:
    if not args:
        _error("Usage: invalidate <repo>")

    from jcodemunch_mcp.tools.invalidate_cache import invalidate_cache

    result = invalidate_cache(repo=args[0])
    _print_json(result)


COMMANDS = {
    "index_folder": cmd_index_folder,
    "search_symbols": cmd_search_symbols,
    "get_symbol": cmd_get_symbol,
    "get_symbols": cmd_get_symbols,
    "file_outline": cmd_file_outline,
    "repo_outline": cmd_repo_outline,
    "list_repos": cmd_list_repos,
    "invalidate": cmd_invalidate,
}


def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        cmds = ", ".join(sorted(COMMANDS))
        _error(f"Usage: cli.py <command> [args...]\nCommands: {cmds}")

    cmd_name = sys.argv[1]
    handler = COMMANDS.get(cmd_name)
    if not handler:
        _error(f"Unknown command: {cmd_name}. Available: {', '.join(sorted(COMMANDS))}")

    try:
        handler(sys.argv[2:])
    except ImportError as e:
        _error(f"jcodemunch-mcp is not installed: {e}")
    except Exception as e:
        _error(f"{type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
