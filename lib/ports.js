// Cross-platform port probing via TCP connect. Avoids netstat/lsof/Get-NetTCPConnection
// shell differences — works the same on Windows/Mac/Linux under any shell.

import net from "net";

// Probe both IPv4 (127.0.0.1) and IPv6 (::1) loopbacks, in parallel.
// Returns true if either accepts a connection. This catches the common
// case where Vite (and a few other Node dev servers) bind only to ::1 by
// default — an IPv4-only probe would have reported the service stopped.
//
// Caller can pin to a single host by passing it explicitly; the parallel
// dual-stack probe runs only when host is omitted.
export function isPortInUse(port, host = null, timeoutMs = 600) {
  if (host) return _probeOne(port, host, timeoutMs);
  return Promise.all([
    _probeOne(port, "127.0.0.1", timeoutMs),
    _probeOne(port, "::1", timeoutMs),
  ]).then(([v4, v6]) => v4 || v6);
}

function _probeOne(port, host, timeoutMs) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (inUse) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(inUse);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
    sock.connect(port, host);
  });
}

export async function probeMany(ports) {
  return Promise.all(
    ports.map(async (port) => ({ port, inUse: await isPortInUse(port) })),
  );
}

// HTTP GET with a small timeout. Returns true on any HTTP response — any
// answer at all means the service is alive enough to bind+respond.
//
// Like isPortInUse, probes both 127.0.0.1 and ::1 in parallel when host is
// omitted. Vite (and other dev servers) often bind only to ::1 by default;
// an IPv4-only probe would falsely report "no HTTP response" and cause
// `ym doctor` to flag a healthy frontend as a foreign process.
export function isHttpAlive(port, path = "/", host = null, timeoutMs = 1500) {
  if (host) return _httpAliveOne(port, path, host, timeoutMs);
  return Promise.all([
    _httpAliveOne(port, path, "127.0.0.1", timeoutMs),
    _httpAliveOne(port, path, "::1", timeoutMs),
  ]).then(([v4, v6]) => v4 || v6);
}

function _httpAliveOne(port, path, host, timeoutMs) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    let data = "";

    const finish = (alive) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(alive);
    };

    // IPv6 addresses must be bracketed in the HTTP Host header (RFC 7230).
    const hostHeader = host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;

    sock.setTimeout(timeoutMs);
    sock.once("connect", () => {
      sock.write(
        `GET ${path} HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`,
      );
    });
    sock.on("data", (chunk) => {
      data += chunk.toString();
      if (data.startsWith("HTTP/")) finish(true);
    });
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
    sock.once("close", () => finish(data.startsWith("HTTP/")));
    sock.connect(port, host);
  });
}
