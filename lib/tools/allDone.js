'use strict';

/**
 * Waits until all promises have settled, then rejects with the first error, if any.
 *
 * For database writes of one received telegram that run at the same time: when this resolves or rejects, nothing
 * of the telegram is still being written, so the receive queue can start the next one. Promise.all would reject
 * at the first error while the other writes are still under way. Only the first error in array order is passed on;
 * further errors of the same writes (usually the same cause, e.g. the database is gone) are not reported.
 * @param {Promise<any>[]} promises
 * @returns {Promise<void>}
 */
async function allDone(promises) {
	const results = await Promise.allSettled(promises);
	const failed = results.find((r) => r.status === 'rejected');
	if (failed) {
		throw failed.reason;
	}
}

module.exports = allDone;
