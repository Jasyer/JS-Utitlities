const ping = require('ping');
const minimist = require('minimist');
const path = require('path');
const { default: PromiseQueue } = require('p-queue');
const readline = require('readline');
const whois = require('whois');

const args = minimist(process.argv.slice(2));
if (args._.length != 1 || Object.keys(args).length > 2) {
    console.log(`Usage: ${process.argv.slice(0, 2).join(' ')} [--workers n] pattern`);
    console.log('pattern could be only with fixed length (ex. exampl?.com)');
    console.log();
    process.exit(1);
}

const pattern = args._[0];
const workersQty = args.workers || 10;

String.prototype.replaceAt = function (i, substr) {
    return this.slice(0, i) + substr + this.slice(i + 1);
};
String.prototype.incChar = function (i) {
    return this.replaceAt(i, String.fromCharCode(this.charCodeAt(i) + 1));
};
String.prototype.multiply = function (n) {
    return Array.from(new Array(n)).reduce((prev) => prev + this, '');
};

function loadingBar(ratio, width) {
    const FULL = '\u2588';
    const EIGHTS = [
        '',
        ...Array.from(new Array(7))
            .map((_, index) => String.fromCharCode(FULL.charCodeAt(0) + index + 1))
            .reverse(),
    ];

    const total = (width - 2) * 8;
    const current = Math.round(total * ratio);

    return '[' + (FULL.multiply(Math.floor(current / 8)) + EIGHTS[current % 8]).padEnd(width - 2) + ']';
}

function AddressGenerator(pattern) {
    this.pattern = pattern;
    this._indexes = pattern.split('').reduce((prev, curr, index) => (curr === '?' ? [...prev, index] : prev), []);
    this._address = pattern.replace(/\?/g, 'a');

    this.generate = (number = null) => {
        const addresses = [];
        while (this._address && (number === null || number-- > 0)) {
            let index = this._indexes.length - 1;
            while (index >= 0 && this._address[this._indexes[index]] === 'z') {
                this._address = this._address.replaceAt(this._indexes[index], 'a');
                index--;
            }
            if (index < 0) {
                this._address = null;
            } else {
                addresses.push(this._address);
                this._address = this._address.incChar(this._indexes[index]);
            }
        }
        return addresses;
    };

    this.isExhausted = () => {
        return this._address === null;
    };
}

function AddressChecker() {
    this.lastChecked = null;
    this.foundAddresses = [];
    this.stopped = true;
    this.failedAddresses = [];

    this._checkQueue = new PromiseQueue({ concurrency: 8, autoStart: false });
    this._totalAddresses = 0;

    this.load = (addresses) => {
        addresses.forEach((address) => {
            this._checkQueue.add(async () => {
                try {
                    if (!(await this._checkExist(address))) {
                        this.foundAddresses.push(address);
                    }
                } catch (error) {
                    this.failedAddresses.push(address);
                }
                this.lastChecked = address;
            });
        });
    };

    this.start = () => {
        this._totalAddresses = this._checkQueue.size;
        this._checkQueue.onEmpty().then(() => (this.stopped = true));
        this.stopped = false;

        this._checkQueue.start();
    };

    this.getInfo = () => {
        const address = this.lastChecked || '-';
        const ratio = (this._totalAddresses - this._checkQueue.size) / this._totalAddresses;

        const loading = `${loadingBar(ratio, 16)} ${Math.floor(ratio * 100)}%`;
        const found = this.foundAddresses.length ? ` found: ${this.foundAddresses.length}` : '';
        const failed = this.failedAddresses.length ? ` failed: ${this.failedAddresses.length}` : '';

        return address.padEnd(pattern.length + 2) + loading + found + failed;
    };

    this._checkExist = async (address) => {
        const res = await ping.promise.probe(address);
        return res.alive || (await this._checkWhois(address));
    };

    this._checkWhois = async (address) =>
        new Promise((resolve, reject) => {
            whois.lookup(address, (err, data) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(!data.includes('No entries found'));
                }
            });
        });
}

function CheckerLogger(checkers) {
    this._checkers = checkers;
    this._loadingState = 0;
    this._intervalId = null;
    this._logQueue = new PromiseQueue();

    this.start = () => {
        this._checkers.forEach(() => console.log());
        this._intervalId = setInterval(() => {
            this._logQueue.add(() => {
                this._checkers.forEach((_, index) => {
                    this._checkerInfo(index);
                });
            });
        }, 250);
    };

    this.stop = async () => {
        if (this._intervalId) {
            clearInterval(this._intervalId);
        }
        this._intervalId = null;
        await this._logQueue.onEmpty();
    };

    this._checkerInfo = (index) => {
        const checker = this._checkers[index];

        readline.moveCursor(process.stdout, 0, index - this._checkers.length);
        process.stdout.clearLine();
        process.stdout.cursorTo(0);

        process.stdout.write(`#${String(index).padEnd(4)}${checker.getInfo()}`);
        readline.moveCursor(process.stdout, 0, this._checkers.length - index);
    };
}

console.log(`Checking addresses matching pattern '${pattern}':`);

const workers = [];
for (let i = 0; i < workersQty; i++) {
    workers.push(new AddressChecker());
}
const generator = new AddressGenerator(pattern);

let workerIndex = 0;
while (!generator.isExhausted()) {
    workers[workerIndex].load(generator.generate(10));
    workerIndex = (workerIndex + 1) % workers.length;
}

const logger = new CheckerLogger(workers);
logger.start();

workers.forEach((worker) => worker.start());

function writeAddresses(addresses) {
    process.stdout.cursorTo(0);

    const [x] = process.stdout.getWindowSize();
    const columnsQty = Math.floor((x + 1) / (pattern.length + 1));
    addresses.forEach((address, index) => {
        process.stdout.write(`${address}`);
        if ((index + 1) % columnsQty === 0) {
            console.log();
        } else {
            process.stdout.write(' ');
        }
    });
    console.log();
}

setInterval(() => {
    if (workers.every((worker) => worker.stopped)) {
        logger.stop().then(() => {
            const found = workers.reduce((sum, worker) => [...sum, ...worker.foundAddresses], []).sort();
            const failed = workers.reduce((sum, worker) => [...sum, ...worker.failedAddresses], []).sort();

            process.stdout.cursorTo(0);

            console.log('Found addresses:');
            writeAddresses(found);

            console.log('Failed to check:');
            writeAddresses(failed);

            process.exit(0);
        });
    }
}, 1000);
