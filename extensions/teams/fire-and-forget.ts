import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

/**
 * Safely execute a promise without awaiting it. Any rejection is caught and
 * logged as a warning via `ctx.ui.notify` (when a context is available).
 *
 * Use this instead of bare `void promise` to prevent unhandled promise
 * rejections from fire-and-forget async operations.
 */
export function fireAndForget(p: Promise<unknown>, ctx?: ExtensionContext | null): void {
	p.catch((err: unknown) => {
		ctx?.ui.notify(`Background error: ${err instanceof Error ? err.message : String(err)}`, "warning");
	});
}
