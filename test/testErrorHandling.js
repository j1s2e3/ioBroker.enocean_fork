'use strict';

// Runs with mocha (npm run test:js) and with the Node test runner: node --test test/testErrorHandling.js
const assert = require('node:assert/strict');
const { describe, it, afterEach } = typeof global.describe === 'function' ? global : require('node:test');

const { TestEnv, sleep } = require('./lib/harness');

/** mocha: more time than the default 2 s for these end-to-end tests (no-op with node --test) */
function allowTime(ctx) {
	if (ctx && typeof ctx.timeout === 'function') {
		ctx.timeout(10000);
	}
}

// FL62 as in the installation: taught to sender ID base + 0x1f
const FL62 = '041450ed';
const FL62_NATIVE = { baseIDoffset: 31, Sender_ID: 'ffcf279f' };

/** A5 telegrams the gateway was asked to send, as hex of the radio data (R-ORG .. status) */
function sentA5(env) {
	return env.radio.filter((d) => d[0] === 0xa5).map((d) => d.toString('hex'));
}

describe('errors do not stop the adapter', function () {
	allowTime(this);
	let env;
	afterEach(async () => {
		if (env) {
			await env.stop();
			env = null;
		}
	});

	it('logs an error in onStateChange and keeps working', async () => {
		env = new TestEnv();
		env.addDevice(FL62, ['TF-13-11', 'TF-14-02'], FL62_NATIVE);
		// broken device: sender ID offset without Sender_ID -> TypeError while building the telegram
		env.addDevice('0badbeef', ['TF-13-11', 'TF-14-02'], { baseIDoffset: 5 });
		env.start();
		await env.waitConnected();

		await env.write('0badbeef.CMD', 1);
		await sleep(30);
		await env.write(`${FL62}.CMD`, 1);
		await env.waitFor(() => sentA5(env).length > 0, 1000, 'FL62 telegram');
		await env.settle();

		assert.equal(env.unhandled.length, 0, 'no unhandled promise rejection (would stop the adapter)');
		assert.ok(
			env.logs.error.some((m) => m.startsWith('stateChange enocean.0.0badbeef.CMD')),
			'error logged: ' + env.logs.error.join(' | '),
		);
		assert.deepEqual(sentA5(env), ['a501000009ffcf279f00'], 'FL62 "on" sent with its sender ID');
	});

	it('drops a broken entry of the send queue and sends the next one', async () => {
		env = new TestEnv();
		env.addDevice(FL62, ['TF-13-11', 'TF-14-02'], FL62_NATIVE);
		env.start();
		await env.waitConnected();

		env.adapter.queue.push({ data: undefined, optionaldata: null, packettype: 0x01 });
		await env.write(`${FL62}.CMD`, 0);
		await env.waitFor(() => sentA5(env).length > 0, 1000, 'FL62 telegram after the broken entry');
		await env.settle();

		assert.equal(env.unhandled.length, 0);
		assert.ok(env.logs.error.some((m) => m.startsWith('Sending a telegram failed, it is dropped')));
		assert.deepEqual(sentA5(env), ['a501000008ffcf279f00'], 'FL62 "off" sent');
	});

	it('logs an error while creating an unknown device (message newDevice)', async () => {
		env = new TestEnv();
		env.start();
		await env.waitConnected();

		env.adapter.emit('message', {
			command: 'newDevice',
			message: { device: 'does_not_exist', mfr: 'eltako', id: '01234567' },
			from: 'system.adapter.admin.0',
		});
		await env.waitFor(() => env.logs.error.length > 0, 1000, 'error log');
		await env.settle();

		assert.equal(env.unhandled.length, 0);
		assert.ok(env.logs.error.some((m) => m.startsWith('Creating device failed')), env.logs.error.join(' | '));
	});
});
