'use strict';

/*
 * Test harness: runs main.js against an in-memory ioBroker and a simulated USB gateway (ESP3).
 * No ioBroker installation, no serial port and no network are needed; json-logic-js must be resolvable
 * (it is, after "npm install" in the repository or in the installed adapter directory).
 *
 * - @iobroker/adapter-core, serialport and @jey-cee/dm-utils are replaced by the fakes below.
 * - Objects and states are each served by a FIFO queue like the adapter's two database connections. Single calls
 *   can be delayed (hang) to reproduce a stalling database.
 * - The gateway answers the start-up commands (version, repeater, frequency, base ID, learned clients) and every
 *   radio telegram with RET_OK, records what it receives and can be disconnected.
 */

const Module = require('module');
const path = require('path');
const { EventEmitter } = require('events');
const CRC8 = require('../../lib/tools/CRC8');

const ROOT = path.join(__dirname, '..', '..');
const NS = 'enocean.0';

/** @type {TestEnv | null} the environment the next adapter instance belongs to */
let current = null;

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function clone(x) {
	return x === undefined ? undefined : JSON.parse(JSON.stringify(x));
}

/**
 * Like node.extend(true, target, source), which js-controller uses for extendObject: undefined values are
 * skipped, objects and arrays are merged (arrays by index).
 */
function merge(target, source) {
	for (const key of Object.keys(source)) {
		const val = source[key];
		if (val === undefined) {
			continue;
		}
		if (val && typeof val === 'object') {
			const old = target[key];
			const sameKind = old && typeof old === 'object' && Array.isArray(old) === Array.isArray(val);
			target[key] = merge(sameKind ? old : Array.isArray(val) ? [] : {}, val);
		} else {
			target[key] = val;
		}
	}
	return target;
}

/** FIFO like one database connection: each call waits for the previous one, then for its own delay */
function fifo() {
	let tail = Promise.resolve();
	return (fn, delay) => {
		const p = tail.then(
			() =>
				new Promise((resolve, reject) =>
					setTimeout(() => {
						try {
							resolve(fn());
						} catch (e) {
							reject(e);
						}
					}, delay),
				),
		);
		tail = p.catch(() => {});
		return p;
	};
}

/**
 * ESP3 packet
 * @param {number} type
 * @param {Buffer|number[]} data
 * @param {Buffer|number[]} [optional]
 * @returns {Buffer}
 */
function esp3(type, data, optional) {
	data = Buffer.from(data);
	optional = Buffer.from(optional || []);
	const header = Buffer.from([data.length >> 8, data.length & 0xff, optional.length, type]);
	const body = Buffer.concat([data, optional]);
	return Buffer.concat([
		Buffer.from([0x55]),
		header,
		Buffer.from([CRC8.calcCrc8(header)]),
		body,
		Buffer.from([CRC8.calcCrc8(body)]),
	]);
}

/**
 * Received radio telegram (RADIO_ERP1) as the USB gateway delivers it
 * @param {number} rorg e.g. 0xF6
 * @param {string} payloadHex user data, e.g. '30'
 * @param {string} senderId e.g. '003cd6c1'
 * @param {number} status status byte (bits 0-3: repeater count)
 * @param {number} [dBm] signal strength as positive number (default 60 = -60 dBm)
 * @returns {Buffer}
 */
function radioFrame(rorg, payloadHex, senderId, status, dBm) {
	const data = Buffer.concat([
		Buffer.from([rorg]),
		Buffer.from(payloadHex, 'hex'),
		Buffer.from(senderId, 'hex'),
		Buffer.from([status]),
	]);
	return esp3(1, data, [0x01, 0xff, 0xff, 0xff, 0xff, dBm === undefined ? 60 : dBm, 0x00]);
}

function patternToRegExp(pattern) {
	return new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
}

// --- fakes ------------------------------------------------------------------------------------------------

class FakeAdapter extends EventEmitter {
	constructor(options) {
		super();
		const env = current;
		if (!env) {
			throw new Error('harness: no TestEnv active');
		}
		this.env = env;
		env.adapterInstance = this;
		this.name = options.name;
		this.instance = 0;
		this.namespace = NS;
		this.config = env.config;
		const log = (level) => (msg) => {
			env.logs[level].push(String(msg));
			if (env.verbose) {
				console.log(`${level}: ${msg}`);
			}
		};
		this.log = { silly: log('debug'), debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
		setImmediate(() => this.emit('ready'));
	}

	_objects(op, id, fn) {
		const full = this.env.ns(id);
		this.env.calls.push({ op, id: full });
		return this.env.objQ(() => fn(full), this.env.delayFor(op, full));
	}

	_states(op, id, fn) {
		const full = this.env.ns(id);
		this.env.calls.push({ op, id: full });
		return this.env.stQ(() => fn(full), this.env.delayFor(op, full));
	}

	getForeignObjectAsync(id) {
		this.env.calls.push({ op: 'getForeignObject', id });
		return this.env.objQ(() => {
			if (id === 'system.config') {
				return { common: { language: 'de' } };
			}
			return clone(this.env.objects[id]) || null;
		}, 1);
	}

	getObjectAsync(id) {
		return this._objects('getObject', id, (full) => clone(this.env.objects[full]) || null);
	}

	setObjectAsync(id, obj) {
		return this._objects('setObject', id, (full) => {
			this.env.objects[full] = clone(obj);
			this.env.initDefault(full);
			return { id: full };
		});
	}

	setObjectNotExistsAsync(id, obj) {
		return this._objects('setObjectNotExists', id, (full) => {
			if (!this.env.objects[full]) {
				this.env.objects[full] = clone(obj);
				this.env.initDefault(full);
			}
			return { id: full };
		});
	}

	extendObjectAsync(id, obj) {
		return this._objects('extendObject', id, (full) => {
			this.env.objects[full] = merge(this.env.objects[full] || {}, obj);
			this.env.initDefault(full);
			return { id: full };
		});
	}

	getDevicesAsync() {
		return this._objects('getDevices', 'devices', () =>
			Object.keys(this.env.objects)
				.filter((id) => this.env.objects[id].type === 'device' && id.split('.').length === 3)
				.map((id) => Object.assign({ _id: id }, clone(this.env.objects[id]))),
		);
	}

	deleteDeviceAsync(id) {
		return this._objects('deleteDevice', id, (full) => {
			for (const key of Object.keys(this.env.objects)) {
				if (key === full || key.startsWith(full + '.')) {
					delete this.env.objects[key];
				}
			}
		});
	}

	getStateAsync(id) {
		return this._states('getState', id, (full) => clone(this.env.states[full]) || null);
	}

	setStateAsync(id, state, ack) {
		return this.setState(id, state, ack);
	}

	setState(id, state, ack, callback) {
		if (typeof ack === 'function') {
			callback = ack;
			ack = undefined;
		}
		const st = state !== null && typeof state === 'object' ? Object.assign({}, state) : { val: state };
		if (typeof ack === 'boolean') {
			st.ack = ack;
		}
		if (st.ack === undefined) {
			st.ack = false;
		}
		const p = this._states('setState', id, (full) => {
			const old = this.env.states[full];
			if (st.val === undefined) {
				st.val = old ? old.val : null;
			}
			st.ts = Date.now();
			this.env.states[full] = st;
			this.env.writes.push({ id: full, val: st.val, ack: st.ack, t: Date.now() - this.env.t0 });
			if (this.env.subscriptions.some((re) => re.test(full))) {
				const copy = clone(st);
				setImmediate(() => this.emit('stateChange', full, copy));
			}
			return full;
		});
		if (callback) {
			p.then(() => callback(null), callback);
			return undefined;
		}
		return p;
	}

	subscribeStates(pattern) {
		this.env.subscriptions.push(patternToRegExp(this.env.ns(pattern)));
	}

	sendTo() {}

	terminate(reason) {
		this.env.terminated.push(reason);
	}

	restart() {
		this.env.terminated.push('restart');
	}
}

class FakeSerialPort extends EventEmitter {
	static list() {
		return Promise.resolve([]);
	}

	constructor(options) {
		super();
		this.env = current;
		this.path = options.path;
		this.isOpen = false;
		this.parser = null;
		this.env.ports.push(this);
		if (options.autoOpen !== false) {
			setImmediate(() => this.open());
		}
	}

	pipe(destination) {
		this.parser = destination;
		return destination;
	}

	open(callback) {
		this.env.openAttempts++;
		setImmediate(() => {
			if (!this.env.devicePresent) {
				const err = new Error(`No such file or directory, cannot open ${this.path}`);
				if (callback) {
					callback(err);
				} else {
					this.emit('error', err);
				}
				return;
			}
			this.isOpen = true;
			this.emit('open');
			if (callback) {
				callback(null);
			}
		});
	}

	write(buffer, callback) {
		const data = Buffer.from(buffer);
		if (!this.isOpen) {
			// serialport 10 keeps such data until this very object is opened again
			this.env.heldWrites.push(data);
			return true;
		}
		this.env.sent.push(data);
		if (callback) {
			setImmediate(() => callback(null));
		}
		this.env.gatewayAnswer(this, data);
		return true;
	}

	close(callback) {
		setImmediate(() => {
			const wasOpen = this.isOpen;
			this.isOpen = false;
			if (callback) {
				callback(null);
			}
			if (wasOpen) {
				this.emit('close');
			}
		});
	}

	/** USB stick gone: the port closes on its own */
	disconnect() {
		this.isOpen = false;
		const err = new Error('Disconnected');
		// @ts-ignore
		err.disconnected = true;
		this.emit('close', err);
	}

	/** bytes from the gateway */
	inject(buffer) {
		if (this.parser) {
			this.parser.write(buffer);
		}
	}
}

const fakes = {
	'@iobroker/adapter-core': { Adapter: FakeAdapter },
	serialport: { SerialPort: FakeSerialPort },
	'@jey-cee/dm-utils': {
		DeviceManagement: class {
			constructor(adapter) {
				this.adapter = adapter;
			}
		},
	},
};

const originalLoad = Module._load;
// @ts-ignore
Module._load = function (request, parent) {
	// only for the adapter's own files (also when it is installed under node_modules); other packages,
	// e.g. @iobroker/testing, get the real modules
	if (Object.prototype.hasOwnProperty.call(fakes, request) && parent && parent.filename) {
		const rel = path.relative(ROOT, parent.filename);
		if (!rel.startsWith('..') && !path.isAbsolute(rel) && !rel.split(path.sep).includes('node_modules')) {
			return fakes[request];
		}
	}
	return originalLoad.apply(this, arguments);
};

// --- environment ------------------------------------------------------------------------------------------

class TestEnv {
	/**
	 * @param {object} [options]
	 * @param {object} [options.config] adapter configuration (native)
	 * @param {boolean} [options.verbose] print the adapter log
	 */
	constructor(options) {
		options = options || {};
		this.config = Object.assign(
			{ serialport: '/dev/ttyTEST', ser2net: false, 'ser2net-ip': '', 'ser2net-port': 2000, gateway: 'usb300' },
			options.config,
		);
		this.verbose = !!options.verbose;
		this.t0 = Date.now();
		this.objects = {};
		this.states = {};
		this.writes = [];
		this.calls = [];
		this.logs = { debug: [], info: [], warn: [], error: [] };
		this.subscriptions = [];
		this.hangs = [];
		this.objQ = fifo();
		this.stQ = fifo();
		this.terminated = [];
		this.unhandled = [];
		// gateway
		this.devicePresent = true;
		this.ports = [];
		this.openAttempts = 0;
		this.sent = [];
		this.heldWrites = [];
		this.radio = [];
		this.baseId = 'ffcf2780';
		this.repeater = { mode: 1, level: 1 };
		this.repeaterWrites = [];
		this.repeaterAnswer = 0x00;
		this.radioAnswer = 0x00;
		this.adapterInstance = null;

		this.onUnhandled = (e) => this.unhandled.push(e);
		process.on('unhandledRejection', this.onUnhandled);
		this.addObject('gateway', { type: 'device', common: { name: 'Gateway' }, native: {} });
	}

	ns(id) {
		return id === 'devices' || id.startsWith(NS + '.') ? id : `${NS}.${id}`;
	}

	/** delay of one database call: 1 ms, or a hang registered with hangOnce() */
	delayFor(op, fullId) {
		const i = this.hangs.findIndex((h) => h.op === op && h.re.test(fullId));
		if (i >= 0) {
			const ms = this.hangs[i].ms;
			this.hangs.splice(i, 1);
			return ms;
		}
		return 1;
	}

	/**
	 * The next database call of this kind for a matching id takes ms (all later calls on that connection wait)
	 * @param {string} op e.g. 'getObject', 'setState'
	 * @param {RegExp} re full id
	 * @param {number} ms
	 */
	hangOnce(op, re, ms) {
		this.hangs.push({ op, re, ms });
	}

	addObject(id, obj) {
		this.objects[this.ns(id)] = clone(obj);
		this.initDefault(this.ns(id));
	}

	/** like js-controller: a new state object with common.def gets that value (ack=true) if it has no state */
	initDefault(fullId) {
		const obj = this.objects[fullId];
		if (obj && obj.type === 'state' && obj.common && obj.common.def !== undefined && obj.common.def !== null) {
			if (!this.states[fullId]) {
				this.states[fullId] = { val: obj.common.def, ack: true, q: 0x20, ts: Date.now() };
			}
		}
	}

	/**
	 * @param {string} id device id (= EnOcean ID)
	 * @param {string[]} eeps
	 * @param {object} [native] e.g. {baseIDoffset: 1, Sender_ID: 'ffcf279f'}
	 */
	addDevice(id, eeps, native) {
		this.addObject(id, {
			type: 'device',
			common: { name: id },
			native: Object.assign({ id: id, eep: eeps, manufacturer: 'test', name: id }, native || {}),
		});
	}

	/** load a fresh copy of main.js and create the adapter (start-up follows asynchronously) */
	start() {
		if (current) {
			throw new Error('harness: another TestEnv is still running, call stop() first');
		}
		current = this;
		const mainPath = path.join(ROOT, 'main.js');
		delete require.cache[require.resolve(mainPath)];
		const factory = require(mainPath);
		this.adapter = factory({});
		if (!(this.adapter instanceof FakeAdapter)) {
			throw new Error('harness: @iobroker/adapter-core was not replaced');
		}
		return this.adapter;
	}

	async stop() {
		if (this.adapter) {
			await new Promise((resolve) => this.adapter.emit('unload', resolve));
		}
		await sleep(20);
		process.off('unhandledRejection', this.onUnhandled);
		if (current === this) {
			current = null;
		}
	}

	get port() {
		return this.ports[this.ports.length - 1];
	}

	state(id) {
		const st = this.states[this.ns(id)];
		return st ? st.val : undefined;
	}

	/** gateway initialised and the adapter listens for telegrams */
	connected() {
		const port = this.port;
		return (
			this.state('info.connection') === true &&
			!!port &&
			port.isOpen &&
			!!port.parser &&
			port.parser.listenerCount('data') > 0
		);
	}

	async waitFor(predicate, timeoutMs, what) {
		const end = Date.now() + (timeoutMs || 2000);
		while (Date.now() < end) {
			if (predicate()) {
				return;
			}
			await sleep(5);
		}
		throw new Error(`harness: timeout waiting for ${what || predicate.toString()}`);
	}

	async waitConnected(timeoutMs) {
		await this.waitFor(() => this.connected(), timeoutMs, 'gateway connection');
	}

	/** bytes from the gateway to the adapter */
	inject(buffer) {
		this.port.inject(buffer);
	}

	/** a user or script writes a state (ack=false), as from the admin or another adapter */
	write(id, val, ack) {
		return this.adapter.setState(id, { val: val, ack: !!ack });
	}

	/** all received telegrams processed and the database queues idle */
	async settle() {
		await sleep(5);
		if (this.adapter && this.adapter.rxQueue) {
			await this.adapter.rxQueue.drain();
		}
		await this.objQ(() => null, 0);
		await this.stQ(() => null, 0);
		await sleep(5);
	}

	/** state writes of one device, in order, as 'SHORTCUT=value' */
	writesOf(deviceId) {
		const prefix = `${NS}.${deviceId}.`;
		return this.writes
			.filter((w) => w.id.startsWith(prefix))
			.map((w) => `${w.id.slice(prefix.length)}=${w.val}`)
			.filter((w) => !/^(rssi|repeated)=/.test(w));
	}

	/** ESP3 packets written to the gateway with this packet type */
	sentOfType(type) {
		return this.sent.filter((p) => p[4] === type);
	}

	gatewayAnswer(port, packet) {
		if (packet[0] !== 0x55) {
			return;
		}
		const dataLength = packet.readUInt16BE(1);
		const type = packet[4];
		const data = packet.slice(6, 6 + dataLength);
		let answer = null;
		let optional = [];
		if (type === 5) {
			// COMMON_COMMAND
			switch (data[0]) {
				case 0x03: // CO_RD_VERSION: RET_OK, app 4, api 4, chip id 4, chip version 4, description 16
					answer = Buffer.concat([
						Buffer.from([0x00, 2, 11, 1, 0, 2, 6, 3, 0, 0x01, 0x02, 0x03, 0x04, 0x45, 0x4f, 0x01, 0x03]),
						Buffer.from('GATEWAYCTRL\0\0\0\0\0'),
					]);
					break;
				case 0x0a: // CO_RD_REPEATER
					answer = Buffer.from([0x00, this.repeater.mode, this.repeater.level]);
					break;
				case 0x25: // CO_GET_FREQUENCY_INFO
					answer = Buffer.from([0x00, 0x00, 0x00]);
					break;
				case 0x08: // CO_RD_IDBASE
					answer = Buffer.concat([Buffer.from([0x00]), Buffer.from(this.baseId, 'hex')]);
					optional = [0x0a];
					break;
				case 0x09: // CO_WR_REPEATER
					this.repeaterWrites.push([data[1], data[2]]);
					if (this.repeaterAnswer === 0x00) {
						this.repeater = { mode: data[1], level: data[2] };
					}
					answer = Buffer.from([this.repeaterAnswer]);
					break;
				default:
					answer = Buffer.from([0x02]); // RET_NOT_SUPPORTED
			}
		} else if (type === 6) {
			// SMART_ACK_COMMAND, e.g. SA_RD_LEARNEDCLIENTS: none
			answer = Buffer.from([0x00]);
		} else if (type === 1) {
			// RADIO_ERP1 to send
			this.radio.push(data);
			answer = Buffer.from([this.radioAnswer]);
		}
		if (answer) {
			const response = esp3(2, answer, optional);
			setTimeout(() => port.isOpen && port.inject(response), 2);
		}
	}
}

module.exports = { TestEnv, esp3, radioFrame, sleep, ROOT };
