'use strict';

/*
 * Generic Flutter/Dart HTTPS proxy via HTTP CONNECT.
 *
 * - Proxies all IPv4 TCP connections to port 443.
 * - Preserves the original hostname in the CONNECT request when known.
 * - Falls back to the destination IP if hostname resolution is unknown.
 * - Compatible with standard Burp HTTP proxy mode.
 */

const proxy = {
    ipv4: '10.88.88.66',
    port: 8080,
    timeoutMs: 10000
};

const AF_INET = 2;
const EINTR = 4;
const EAGAIN = 35;
const EINPROGRESS = 36;
const ETIMEDOUT = 60;
const ECONNREFUSED = 61;
const SOL_SOCKET = 0xffff;
const SO_ERROR = 0x1007;
const SO_NOSIGPIPE = 0x1022;
const POLLIN = 0x0001;
const POLLOUT = 0x0004;

// Maps resolved IPv4 addresses to hostnames.
const targetAddresses = Object.create(null);

function findExport(name) {
    const address = Module.findGlobalExportByName(name);
    if (address === null) {
        throw new Error('Required export unavailable: ' + name);
    }
    return address;
}

const getErrorPointer = new NativeFunction(
    findExport('__error'), 'pointer', []
);

const pollNative = new NativeFunction(
    findExport('poll'), 'int', ['pointer', 'ulong', 'int']
);

const sendNative = new NativeFunction(
    findExport('send'), 'int64', ['int', 'pointer', 'ulong', 'int']
);

const recvNative = new NativeFunction(
    findExport('recv'), 'int64', ['int', 'pointer', 'ulong', 'int']
);

const getsockoptNative = new NativeFunction(
    findExport('getsockopt'),
    'int',
    ['int', 'int', 'int', 'pointer', 'pointer']
);

const setsockoptNative = new NativeFunction(
    findExport('setsockopt'),
    'int',
    ['int', 'int', 'int', 'pointer', 'uint32']
);

function setErrno(value) {
    getErrorPointer().writeS32(value);
}

function readSockaddr(address) {
    if (address.isNull()) return null;

    const family = address.add(1).readU8();
    const port =
        (address.add(2).readU8() << 8) |
        address.add(3).readU8();

    if (family !== AF_INET) {
        return {
            family: family,
            host: null,
            port: port
        };
    }

    const octets = [];

    for (let i = 0; i < 4; i++) {
        octets.push(address.add(4 + i).readU8());
    }

    return {
        family: family,
        host: octets.join('.'),
        port: port
    };
}

function makeIpv4Sockaddr(host, port) {
    const octets = host.split('.').map(
        value => Number.parseInt(value, 10)
    );

    if (octets.length !== 4 || octets.some(value =>
        !Number.isInteger(value) || value < 0 || value > 255
    )) {
        throw new Error('Invalid proxy IPv4 address: ' + host);
    }

    const address = Memory.alloc(16);
    address.writeByteArray(new Uint8Array(16));

    address.writeU8(16);
    address.add(1).writeU8(AF_INET);
    address.add(2).writeU8((port >> 8) & 0xff);
    address.add(3).writeU8(port & 0xff);

    for (let i = 0; i < 4; i++) {
        address.add(4 + i).writeU8(octets[i]);
    }

    return address;
}

const proxySockaddr = makeIpv4Sockaddr(
    proxy.ipv4,
    proxy.port
);

function writeProxySockaddr(address) {
    address.writeByteArray(
        proxySockaddr.readByteArray(16)
    );
}

function waitFor(fd, events, deadline) {
    const descriptor = Memory.alloc(8);

    descriptor.writeS32(fd);
    descriptor.add(4).writeS16(events);
    descriptor.add(6).writeS16(0);

    while (true) {
        const remaining = deadline - Date.now();

        if (remaining <= 0) {
            setErrno(ETIMEDOUT);
            return false;
        }

        const result = pollNative(
            descriptor, 1, remaining
        );

        if (result > 0) return true;

        if (result === 0) {
            setErrno(ETIMEDOUT);
            return false;
        }

        if (getErrorPointer().readS32() !== EINTR) {
            return false;
        }
    }
}

function socketError(fd) {
    const value = Memory.alloc(4);
    const length = Memory.alloc(4);

    value.writeS32(0);
    length.writeU32(4);

    if (getsockoptNative(
        fd, SOL_SOCKET, SO_ERROR, value, length
    ) !== 0) {
        return getErrorPointer().readS32();
    }

    return value.readS32();
}

function sendAll(fd, bytes, deadline) {
    const buffer = Memory.alloc(bytes.length);
    buffer.writeByteArray(bytes);

    let offset = 0;

    while (offset < bytes.length) {
        const sent = Number(sendNative(
            fd,
            buffer.add(offset),
            bytes.length - offset,
            0
        ));

        if (sent > 0) {
            offset += sent;
            continue;
        }

        const error = getErrorPointer().readS32();

        if (sent < 0 && error !== EAGAIN && error !== EINTR) {
            return false;
        }

        if (!waitFor(fd, POLLOUT, deadline)) {
            return false;
        }
    }

    return true;
}

function asciiBytes(text) {
    const bytes = new Uint8Array(text.length);

    for (let i = 0; i < text.length; i++) {
        bytes[i] = text.charCodeAt(i) & 0x7f;
    }

    return bytes;
}

function readConnectResponse(fd, deadline) {
    const buffer = Memory.alloc(2048);
    let response = '';

    while (
        response.indexOf('\r\n\r\n') === -1 &&
        response.length < 32768
    ) {
        const received = Number(
            recvNative(fd, buffer, 2048, 0)
        );

        if (received > 0) {
            response += buffer.readUtf8String(received);
            continue;
        }

        if (received === 0) return null;

        const error = getErrorPointer().readS32();

        if (error !== EAGAIN && error !== EINTR) {
            return null;
        }

        if (!waitFor(fd, POLLIN, deadline)) {
            return null;
        }
    }

    return response;
}

function establishTunnel(
    fd,
    hostname,
    port,
    connectResult,
    connectError
) {
    const deadline = Date.now() + proxy.timeoutMs;

    const noSigpipe = Memory.alloc(4);
    noSigpipe.writeS32(1);

    setsockoptNative(
        fd, SOL_SOCKET, SO_NOSIGPIPE, noSigpipe, 4
    );

    if (connectResult !== 0) {
        if (
            connectError !== EINPROGRESS &&
            connectError !== EAGAIN
        ) {
            return -1;
        }

        if (!waitFor(fd, POLLOUT, deadline)) {
            return -1;
        }

        const completionError = socketError(fd);

        if (completionError !== 0) {
            setErrno(completionError);
            return -1;
        }
    }

    const request =
        'CONNECT ' + hostname + ':' + port + ' HTTP/1.1\r\n' +
        'Host: ' + hostname + ':' + port + '\r\n' +
        'Proxy-Connection: Keep-Alive\r\n\r\n';

    if (!sendAll(fd, asciiBytes(request), deadline)) {
        return -1;
    }

    const response = readConnectResponse(fd, deadline);

    if (response === null) return -1;

    const statusLine = response.split('\r\n', 1)[0];
    const match = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine);

    if (
        match === null ||
        Number(match[1]) < 200 ||
        Number(match[1]) >= 300
    ) {
        console.error('[proxy] CONNECT rejected: ' + statusLine);
        setErrno(ECONNREFUSED);
        return -1;
    }

    console.log('[proxy] Tunnel established: ' + statusLine);

    return 0;
}

/*
 * Hook getaddrinfo().
 * Record IPv4 resolutions for all hostnames.
 */

function rememberResolvedAddresses(resultPointer, hostname) {
    let info = resultPointer.readPointer();
    let entries = 0;

    // Darwin arm64 addrinfo layout.
    while (!info.isNull() && entries++ < 64) {
        const family = info.add(4).readS32();
        const sockaddr = info.add(32).readPointer();

        if (family === AF_INET && !sockaddr.isNull()) {
            const endpoint = readSockaddr(sockaddr);

            targetAddresses[endpoint.host] = hostname;

            console.log(
                '[proxy] DNS ' + hostname +
                ' -> ' + endpoint.host
            );
        }

        info = info.add(40).readPointer();
    }
}

Interceptor.attach(
    findExport('getaddrinfo'),
    {
        onEnter(args) {
            this.hostname = null;
            this.resultPointer = args[3];

            if (!args[0].isNull()) {
                this.hostname = args[0].readUtf8String();
            }
        },

        onLeave(result) {
            if (
                this.hostname === null ||
                result.toInt32() !== 0 ||
                this.resultPointer.isNull()
            ) {
                return;
            }

            try {
                rememberResolvedAddresses(
                    this.resultPointer,
                    this.hostname
                );
            } catch (error) {
                console.error(
                    '[proxy] DNS parsing failed: ' + error
                );
            }
        }
    }
);

console.log('[+] Hooked getaddrinfo');

/*
 * Hook connect().
 * Redirect every IPv4 TCP connection on port 443.
 */

Interceptor.attach(
    findExport('connect'),
    {
        onEnter(args) {
            this.target = null;

            try {
                const endpoint = readSockaddr(args[1]);

                if (
                    endpoint === null ||
                    endpoint.family !== AF_INET ||
                    endpoint.port !== 443
                ) {
                    return;
                }

                const hostname =
                    targetAddresses[endpoint.host] ||
                    endpoint.host;

                this.target = {
                    fd: args[0].toInt32(),
                    hostname: hostname,
                    endpoint: endpoint.host + ':443'
                };

                writeProxySockaddr(args[1]);

                console.log(
                    '[proxy] Redirecting ' +
                    this.target.hostname +
                    ' (' + this.target.endpoint + ') -> ' +
                    proxy.ipv4 + ':' + proxy.port
                );

            } catch (error) {
                console.error(
                    '[proxy] connect rewrite failed: ' + error
                );
            }
        },

        onLeave(result) {
            if (this.target === null) return;

            const connectResult = result.toInt32();

            const connectError =
                connectResult === -1
                    ? getErrorPointer().readS32()
                    : 0;

            console.log(
                '[proxy] CONNECT tunnel: ' +
                this.target.hostname
            );

            try {
                const tunnelResult = establishTunnel(
                    this.target.fd,
                    this.target.hostname,
                    443,
                    connectResult,
                    connectError
                );

                if (tunnelResult === 0) {
                    result.replace(0);
                    setErrno(0);
                } else {
                    const error = getErrorPointer().readS32();

                    console.error(
                        '[proxy] Tunnel failed, errno=' + error
                    );

                    result.replace(-1);
                }

            } catch (error) {
                console.error(
                    '[proxy] Tunnel setup failed: ' + error
                );

                setErrno(ECONNREFUSED);
                result.replace(-1);
            }
        }
    }
);

console.log('[+] Hooked connect');
console.log('[+] Generic Flutter HTTPS proxy active');
console.log('[+] Mode: ALL IPv4 TCP connections to port 443');
console.log('[+] Proxy: ' + proxy.ipv4 + ':' + proxy.port);
console.log('[+] Timeout: ' + proxy.timeoutMs + ' ms');
