#!/usr/bin/env python3
"""Tiny PTY host for Pocket IDE terminals (replaces the native node-pty addon).

    python3 pty-helper.py <program> [args...]

stdin  -> keystrokes for the program
stdout <- everything the program prints (raw terminal output)
fd 3   -> control lines: "<rows> <cols>\n" resizes the terminal
Initial size comes from PTY_ROWS / PTY_COLS. Exits with the program's exit code.
Pure standard library, so it works anywhere Python 3 does (incl. proot on Android).
"""
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def write_all(fd, data):
    while data:
        try:
            n = os.write(fd, data)
        except InterruptedError:
            continue
        data = data[n:]


def main():
    argv = sys.argv[1:] or [os.environ.get("SHELL", "/bin/sh")]
    rows = int(os.environ.get("PTY_ROWS", "24"))
    cols = int(os.environ.get("PTY_COLS", "80"))

    pid, master = pty.fork()
    if pid == 0:  # child: become the program
        try:
            os.execvp(argv[0], argv)
        except OSError as e:
            sys.stderr.write("pty-helper: cannot run %s: %s\n" % (argv[0], e))
            os._exit(127)

    def set_size(r, c):
        # Setting the size on the master also sends SIGWINCH to the program.
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))

    set_size(rows, cols)

    def stop(*_):
        try:
            os.kill(pid, signal.SIGHUP)
        except OSError:
            pass
        sys.exit(129)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGHUP, stop)

    try:
        os.fstat(3)
        inputs = [0, master, 3]
    except OSError:
        inputs = [0, master]
    ctl_buf = b""

    while True:
        try:
            ready, _, _ = select.select(inputs, [], [])
        except InterruptedError:
            continue
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError as e:  # EIO once the program has exited
                data = b"" if e.errno in (errno.EIO, errno.EBADF) else b""
            if not data:
                break
            write_all(1, data)
        if 0 in ready:
            data = os.read(0, 65536)
            if not data:  # IDE closed our stdin: hang up the program
                inputs.remove(0)
                stop()
            else:
                write_all(master, data)
        if 3 in ready:
            data = os.read(3, 4096)
            if not data:
                inputs.remove(3)
            else:
                ctl_buf += data
                while b"\n" in ctl_buf:
                    line, ctl_buf = ctl_buf.split(b"\n", 1)
                    try:
                        r, c = (int(x) for x in line.split())
                        if r > 0 and c > 0:
                            set_size(min(r, 500), min(c, 1000))
                    except ValueError:
                        pass

    _, status = os.waitpid(pid, 0)
    if os.WIFEXITED(status):
        sys.exit(os.WEXITSTATUS(status))
    sys.exit(128 + os.WTERMSIG(status) if os.WIFSIGNALED(status) else 1)


if __name__ == "__main__":
    main()
