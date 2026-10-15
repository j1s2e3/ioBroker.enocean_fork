'use strict';

/**
 * Runs the handler for received packets strictly one after another.
 *
 * The serial/TCP parser emits 'data' without waiting for the async handler. Without this queue the database
 * accesses of two telegrams interleave as soon as one call stalls: e.g. a button release writes REL=true before
 * the press telegram has written its buttons, and a button can stay true.
 */
class ReceiveQueue {
	/**
	 * @param {(data: Buffer) => Promise<any>} handler processes one packet
	 * @param {object} options
	 * @param {{warn: (msg: string) => void, error: (msg: string) => void}} options.log
	 * @param {number} [options.timeoutMs] continue with the next packet if one takes longer (default 10 s)
	 * @param {number} [options.warnPending] warn once when this many packets are waiting (default 50)
	 */
	constructor(handler, options) {
		this.handler = handler;
		this.log = options.log;
		this.timeoutMs = options.timeoutMs || 10000;
		this.warnPending = options.warnPending || 50;
		this.pending = 0;
		this.warned = false;
		this.tail = Promise.resolve();
	}

	/**
	 * Queue one packet. Never throws; the returned promise never rejects and resolves when the packet is done.
	 * @param {Buffer} data
	 * @returns {Promise<void>}
	 */
	push(data) {
		this.pending++;
		if (this.pending >= this.warnPending && !this.warned) {
			this.warned = true;
			this.log.warn(`Receive queue: ${this.pending} telegrams waiting, processing is slow (database?)`);
		}
		this.tail = this.tail
			.then(() => this.run(data))
			.then(() => {
				this.pending--;
				if (this.pending === 0) {
					this.warned = false;
				}
			});
		return this.tail;
	}

	/**
	 * Resolves when everything queued so far is done.
	 * @returns {Promise<void>}
	 */
	drain() {
		return this.tail;
	}

	/**
	 * Process one packet; errors are logged, a hanging handler is left behind after timeoutMs.
	 * @param {Buffer} data
	 * @returns {Promise<void>}
	 */
	run(data) {
		return new Promise((resolve) => {
			let finished = false;
			const timer = setTimeout(() => {
				finished = true;
				this.log.warn(
					`Processing telegram ${hex(data)} took longer than ${this.timeoutMs / 1000} s, continuing with the next one`,
				);
				resolve();
			}, this.timeoutMs);

			let result;
			try {
				result = Promise.resolve(this.handler(data));
			} catch (e) {
				result = Promise.reject(e);
			}
			result
				.catch((e) => {
					this.log.error(`Processing telegram ${hex(data)} failed: ${(e && e.stack) || e}`);
				})
				.then(() => {
					clearTimeout(timer);
					if (!finished) {
						finished = true;
						resolve();
					}
				});
		});
	}
}

/**
 * @param {any} data
 * @returns {string}
 */
function hex(data) {
	return Buffer.isBuffer(data) ? data.toString('hex') : String(data);
}

module.exports = ReceiveQueue;
