#!/usr/bin/env python3
"""
Bridge a podman container port into the WSL distro's ROOT network namespace.

Why this exists
---------------
WSL2 automatically forwards Windows' localhost to any port listening in the
distro's root network namespace — no configuration and no admin rights. Podman
containers get no such treatment: they listen inside podman's own network
namespace, which WSL's forwarder cannot see, so http://localhost:<port> reaches
nothing even though the container is healthy and serving inside the VM.

The historical workaround was `netsh interface portproxy`, routing Windows to
the VM's eth0 IP. That needs an elevated shell, silently breaks whenever the VM's
IP changes on restart, and on setups where Windows cannot reach the WSL subnet it
fails in a particularly confusing way: the proxy accepts the TCP connection and
then resets it, which a browser reports as NS_ERROR_NET_EMPTY_RESPONSE — looking
like a broken web app rather than a broken tunnel.

Running this inside the VM sidesteps all of it: the listener lives in the root
namespace, so WSL forwards localhost to it natively.

Usage: wsl-relay.py <listen_port> <target_port>
"""

import select
import socket
import sys
import threading

BUFSIZE = 65536
# Long enough to not interrupt an idle keep-alive connection, short enough that
# a half-dead socket is eventually reclaimed rather than leaking a thread.
IDLE_TIMEOUT = 60


def pipe(a, b):
    """Shuttle bytes both ways until either side closes."""
    try:
        while True:
            readable, _, _ = select.select([a, b], [], [], IDLE_TIMEOUT)
            if not readable:
                break
            for s in readable:
                data = s.recv(BUFSIZE)
                if not data:
                    return
                (b if s is a else a).sendall(data)
    except OSError:
        pass
    finally:
        for s in (a, b):
            try:
                s.close()
            except OSError:
                pass


def main():
    if len(sys.argv) != 3:
        print(f"usage: {sys.argv[0]} <listen_port> <target_port>", file=sys.stderr)
        return 2

    listen_port = int(sys.argv[1])
    target_port = int(sys.argv[2])

    server = socket.socket()
    # The relay is restarted on every `just nc-up`; without SO_REUSEADDR the
    # previous socket's TIME_WAIT state would refuse the rebind.
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("0.0.0.0", listen_port))
    server.listen(128)

    while True:
        client = None
        try:
            client, _ = server.accept()
            upstream = socket.socket()
            upstream.connect(("127.0.0.1", target_port))
            threading.Thread(target=pipe, args=(client, upstream), daemon=True).start()
        except OSError:
            # A refused upstream (container still starting, or restarting) must
            # drop just this connection, never kill the relay.
            if client is not None:
                try:
                    client.close()
                except OSError:
                    pass


if __name__ == "__main__":
    sys.exit(main())
