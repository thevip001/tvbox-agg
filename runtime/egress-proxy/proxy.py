#!/usr/bin/env python3
"""Small fail-closed HTTP CONNECT/forward proxy for untrusted spider containers.

The proxy is the only container attached to an external Docker network. Spider
containers share a per-job --internal network with this gateway and have no
route to the Internet or LAN. Destinations must resolve exclusively to public
global unicast IPs; only TCP 80/443 is allowed.
"""
import ipaddress, select, socket, socketserver, urllib.parse

MAX_HEADER = 32768
MAX_BODY = 8 * 1024 * 1024
MAX_RELAY = 24 * 1024 * 1024
IDLE_TIMEOUT = 15
TOTAL_TIMEOUT = 45
DENIED_NETWORKS = tuple(ipaddress.ip_network(value) for value in (
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
    "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24",
    "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15",
    "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
    "::/128", "::1/128", "::ffff:0:0/96", "64:ff9b::/96", "64:ff9b:1::/48",
    "100::/64", "2001:db8::/32", "2001::/32", "2002::/16", "fc00::/7", "fe80::/10", "ff00::/8",
))

def resolve_public(host, port):
    host = host.rstrip(".").lower()
    if not host or len(host) > 253 or any(c in host for c in "/\\@%"):
        raise ValueError("invalid destination host")
    try:
        literal = ipaddress.ip_address(host.strip("[]"))
        addresses = [str(literal)]
    except ValueError:
        addresses = sorted({item[4][0] for item in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)})
    if not addresses:
        raise ValueError("destination did not resolve")
    parsed = [ipaddress.ip_address(value.split("%", 1)[0]) for value in addresses]
    # Reject the entire answer set if any answer is non-global (DNS rebinding/mixed answers).
    if any(not ip.is_global or ip.is_multicast or ip.is_unspecified or
           any(ip.version == net.version and ip in net for net in DENIED_NETWORKS)
           for ip in parsed):
        raise ValueError("destination resolves to a non-public or special-use IP")
    return addresses

def connect_pinned(host, port):
    errors = []
    for address in resolve_public(host, port):
        family = socket.AF_INET6 if ":" in address else socket.AF_INET
        sock = socket.socket(family, socket.SOCK_STREAM)
        sock.settimeout(8)
        try:
            sock.connect((address, port))
            sock.settimeout(IDLE_TIMEOUT)
            return sock
        except OSError as exc:
            errors.append(str(exc)); sock.close()
    raise OSError("upstream connection failed: " + "; ".join(errors[:3]))

class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.settimeout(8)
        try:
            data = bytearray()
            while b"\r\n\r\n" not in data and len(data) <= MAX_HEADER:
                chunk = self.request.recv(4096)
                if not chunk: return
                data.extend(chunk)
            if len(data) > MAX_HEADER or b"\r\n\r\n" not in data:
                return self.deny(431, "headers too large")
            head, body = bytes(data).split(b"\r\n\r\n", 1)
            lines = head.split(b"\r\n")
            parts = lines[0].decode("latin1").split(" ")
            if len(parts) != 3: return self.deny(400, "bad request")
            method, target, version = parts
            if method.upper() == "CONNECT":
                host, sep, port_text = target.rpartition(":")
                if not sep or not port_text.isdigit() or int(port_text) != 443:
                    return self.deny(403, "CONNECT only supports port 443")
                host = host.strip("[]")
                upstream = connect_pinned(host, 443)
                self.request.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                self.relay(upstream, initial=body)
                return
            url = urllib.parse.urlsplit(target)
            if url.scheme.lower() != "http" or not url.hostname or url.port not in (None, 80) or url.username or url.password:
                return self.deny(403, "only public HTTP port 80 and HTTPS CONNECT 443 are allowed")
            host = url.hostname
            upstream = connect_pinned(host, 80)
            content_length = 0
            for line in lines[1:]:
                low = line.lower()
                if low.startswith(b"content-length:"):
                    try: content_length = int(line.split(b":",1)[1].strip())
                    except ValueError: return self.deny(400, "invalid content length")
                if low.startswith(b"transfer-encoding:"):
                    return self.deny(501, "chunked request bodies are not supported")
            if content_length < 0 or content_length > MAX_BODY or len(body) > MAX_BODY:
                return self.deny(413, "request body too large")
            path = urllib.parse.urlunsplit(("", "", url.path or "/", url.query, ""))
            out = [f"{method} {path} {version}".encode("latin1")]
            has_host = False
            for line in lines[1:]:
                if line.lower().startswith(b"proxy-connection:"): continue
                if line.lower().startswith(b"proxy-authorization:"): continue
                if line.lower().startswith(b"host:"): has_host = True
                out.append(line)
            if not has_host: out.append(("Host: " + host).encode("latin1"))
            upstream.sendall(b"\r\n".join(out) + b"\r\n\r\n" + body)
            self.relay(upstream)
        except (OSError, ValueError, UnicodeError):
            print("egress-error upstream-or-policy-failure", flush=True)
            try: self.deny(502, "upstream rejected or unavailable")
            except OSError: pass

    def deny(self, status, message):
        print(f"egress-deny status={status} reason={message}", flush=True)
        body = (message + "\n").encode()
        self.request.sendall((f"HTTP/1.1 {status} Error\r\nConnection: close\r\nContent-Length: {len(body)}\r\nContent-Type: text/plain\r\n\r\n").encode() + body)

    def relay(self, upstream, initial=b""):
        sockets = [self.request, upstream]
        total = len(initial)
        deadline = __import__("time").monotonic() + TOTAL_TIMEOUT
        try:
            if initial:
                upstream.sendall(initial)
            while True:
                if __import__("time").monotonic() > deadline: break
                readable, _, exceptional = select.select(sockets, [], sockets, IDLE_TIMEOUT)
                if exceptional or not readable: break
                for source in readable:
                    chunk = source.recv(65536)
                    if not chunk: return
                    total += len(chunk)
                    if total > MAX_RELAY: return
                    (upstream if source is self.request else self.request).sendall(chunk)
        finally:
            upstream.close()

class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

if __name__ == "__main__":
    with Server(("0.0.0.0", 3128), Handler) as server:
        server.serve_forever()
