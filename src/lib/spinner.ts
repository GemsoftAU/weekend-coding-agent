// A tiny animated indicator for the REPL: while the agent is between API calls
// it spins a one-cell animation at the start of the output line, then clears
// back to nothing once the turn is done and the prompt is waiting again.
//
// Terminals cannot show a real image, so "gif" here means an ANSI frame
// sequence drawn on one character cell. The terminal's own block cursor is the
// white rectangle described in the request; it is left sitting immediately
// after the glyph, so the rectangle and the animation are adjacent.
import type { WriteStream } from "node:fs";

/** Braille spinner: one narrow character per frame, no wide or emoji glyphs. */
export const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Fallback for terminals without Unicode support. */
export const ASCII_FRAMES = ["|", "/", "-", "\\"];

export interface Spinner {
	/** Start animating. Safe to call twice: the second call is a no-op. */
	start(): void;
	/** Stop animating and erase the frame. Safe when never started. */
	stop(): void;
	/** Whether the animation is currently running. */
	readonly active: boolean;
}

export interface SpinnerOptions {
	/** Stream to write to. Defaults to stderr so piped stdout stays clean. */
	stream?: Pick<WriteStream, "write">;
	frames?: string[];
	/** Milliseconds between frames. */
	intervalMs?: number;
	/** Whether the destination can handle escape codes at all. */
	isTTY?: boolean;
	/** Injected for tests, so no real timers are needed. */
	setIntervalImpl?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
	clearIntervalImpl?: (handle: ReturnType<typeof setInterval>) => void;
}

const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";
const CLEAR_LINE_TO_END = "\x1b[K";
const BACK_ONE = "\x1b[1D";

/**
 * Create a spinner. With `isTTY` false it does nothing at all, so piping the
 * agent's output to a file never gains stray control characters.
 *
 * The cursor is always left immediately *after* the glyph: each frame steps
 * back one cell, overwrites, and lets the write push the cursor forward again.
 */
export function createSpinner(options: SpinnerOptions = {}): Spinner {
	const stream = options.stream ?? process.stderr;
	const frames = options.frames ?? BRAILLE_FRAMES;
	const intervalMs = options.intervalMs ?? 90;
	const isTTY = options.isTTY ?? Boolean((stream as { isTTY?: boolean }).isTTY);
	const setTimer = options.setIntervalImpl ?? setInterval;
	const clearTimer = options.clearIntervalImpl ?? clearInterval;

	let handle: ReturnType<typeof setInterval> | null = null;
	let frame = 0;
	let drawn = false;

	function tick(): void {
		const glyph = frames[frame % frames.length];
		frame++;
		// Step back onto the previous glyph (if any), then draw and advance.
		const steps = drawn ? BACK_ONE : "";
		stream.write(`${CURSOR_HIDE}${steps}${glyph}${CURSOR_SHOW}`);
		drawn = true;
	}

	function start(): void {
		if (handle !== null || !isTTY) return;
		handle = setTimer(tick, intervalMs);
	}

	function stop(): void {
		if (handle === null) return;
		clearTimer(handle);
		handle = null;
		if (drawn) {
			// Step back onto the glyph, then erase the rest of the line.
			stream.write(`${CURSOR_HIDE}${BACK_ONE}${CLEAR_LINE_TO_END}${CURSOR_SHOW}`);
			drawn = false;
		}
	}

	return {
		start,
		stop,
		get active() {
			return handle !== null;
		},
	};
}
