/**
 * Minimal structured logger passed through the engine to providers and hooks. The CLI injects
 * a chalk-colored implementation; the SDK defaults to {@link silentLogger} so library callers
 * get no stray stdout. Keep it tiny on purpose — providers should log _intent_, not noise.
 */
export interface Logger {
	debug(message: string): void;
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

/** A logger that drops everything. The default for programmatic SDK use. */
export const silentLogger: Logger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
};

/** A plain `console`-backed logger (no colors). Handy for tests and simple scripts. */
export const consoleLogger: Logger = {
	debug(message) {
		console.debug(message);
	},
	info(message) {
		console.info(message);
	},
	warn(message) {
		console.warn(message);
	},
	error(message) {
		console.error(message);
	},
};
