import { describe, expect, test } from "bun:test";
import { ASCII_FRAMES, BRAILLE_FRAMES, createSpinner } from "../src/lib/spinner";

/** Capture writes and drive frames by hand instead of waiting on real timers. */
function harness(options: { isTTY?: boolean } = {}) {
	const writes: string[] = [];
	let tick: (() => void) | null = null;
	let cleared = 0;
	let started = false;

	const spinner = createSpinner({
		stream: {
			write: (chunk: string) => {
				writes.push(chunk);
				return true;
			},
		} as never,
		isTTY: options.isTTY ?? true,
		setIntervalImpl: ((fn: () => void) => {
			tick = fn;
			started = true;
			return 1 as never;
		}) as never,
		clearIntervalImpl: (() => {
			cleared++;
		}) as never,
	});

	return {
		spinner,
		writes,
		started: () => started,
		cleared: () => cleared,
		frame: (n = 1) => {
			for (let i = 0; i < n; i++) tick?.();
		},
	};
}

describe("createSpinner", () => {
	test("does not animate until started", () => {
		const h = harness();
		expect(h.started()).toBe(false);
		expect(h.spinner.active).toBe(false);
		expect(h.writes).toHaveLength(0);
	});

	test("writes one narrow glyph per frame", () => {
		const h = harness();
		h.spinner.start();
		h.frame(3);

		expect(h.writes).toHaveLength(3);
		// Every write must contain exactly one visible frame glyph.
		const glyphs = h.writes.map((w) => [...w].filter((c) => BRAILLE_FRAMES.includes(c)));
		expect(glyphs.map((g) => g.join(""))).toEqual(["⠋", "⠙", "⠹"]);
	});

	test("frames are one character wide, so the indicator stays one cell", () => {
		for (const frame of BRAILLE_FRAMES) expect(frame).toHaveLength(1);
		for (const frame of ASCII_FRAMES) expect(frame).toHaveLength(1);
	});

	test("the cursor is hidden while animating and shown again after each frame", () => {
		const h = harness();
		h.spinner.start();
		h.frame(2);

		for (const write of h.writes) {
			expect(write).toContain("\x1b[?25l");
			expect(write).toContain("\x1b[?25h");
			// Hide must come before show, or the cursor flickers.
			expect(write.indexOf("\x1b[?25l")).toBeLessThan(write.indexOf("\x1b[?25h"));
		}
	});

	test("successive frames overwrite in place rather than appending", () => {
		const h = harness();
		h.spinner.start();
		h.frame(3);

		// The first frame has nowhere to step back to; later frames do.
		expect(h.writes[0]).not.toContain("\x1b[1D");
		expect(h.writes[1]).toContain("\x1b[1D");
		expect(h.writes[2]).toContain("\x1b[1D");
	});

	test("stop() clears the interval and erases the glyph", () => {
		const h = harness();
		h.spinner.start();
		h.frame(2);
		h.writes.length = 0;

		h.spinner.stop();

		expect(h.cleared()).toBe(1);
		expect(h.spinner.active).toBe(false);
		// Erase to end of line, so no stray cell is left behind.
		expect(h.writes.join("")).toContain("\x1b[K");
	});

	test("stop() is safe when never started", () => {
		const h = harness();
		expect(() => h.spinner.stop()).not.toThrow();
		expect(h.writes).toHaveLength(0);
		expect(h.cleared()).toBe(0);
	});

	test("start() twice does not stack timers", () => {
		let timers = 0;
		const spinner = createSpinner({
			stream: { write: () => true } as never,
			isTTY: true,
			setIntervalImpl: (() => {
				timers++;
				return 1 as never;
			}) as never,
			clearIntervalImpl: (() => {}) as never,
		});

		spinner.start();
		spinner.start();
		expect(timers).toBe(1);
	});

	test("stop() then start() works again, resetting the erase state", () => {
		const h = harness();
		h.spinner.start();
		h.frame(1);
		h.spinner.stop();
		h.writes.length = 0;

		h.spinner.start();
		h.frame(1);

		expect(h.spinner.active).toBe(true);
		// A fresh start must not step back onto a glyph that is no longer there.
		expect(h.writes[0]).not.toContain("\x1b[1D");
	});

	test("a non-TTY destination gets no escape codes at all", () => {
		const h = harness({ isTTY: false });
		h.spinner.start();
		h.frame(3);
		h.spinner.stop();

		expect(h.writes).toHaveLength(0);
		expect(h.spinner.active).toBe(false);
	});
});
