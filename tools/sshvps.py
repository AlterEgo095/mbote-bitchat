#!/usr/bin/env python3
"""SSH exec helper for VPS ops. Usage: sshvps.py 'command' [timeout_s]"""
import sys
import paramiko

HOST = "95.111.226.63"
PORT = 22
USER = "aenews"
PASSWORD = "AeNews2025Secure!"

def run(cmd: str, timeout: int = 60) -> int:
    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        cli.connect(HOST, port=PORT, username=USER, password=PASSWORD,
                    timeout=20, allow_agent=False, look_for_keys=False)
        stdin, stdout, stderr = cli.exec_command(cmd, timeout=timeout)
        out = stdout.read().decode("utf-8", "replace")
        err = stderr.read().decode("utf-8", "replace")
        rc = stdout.channel.recv_exit_status()
        if out:
            print(out, end="" if out.endswith("\n") else "\n")
        if err:
            print("--- stderr ---", file=sys.stderr)
            print(err, file=sys.stderr)
        return rc
    finally:
        cli.close()

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: sshvps.py 'command' [timeout_s]", file=sys.stderr)
        sys.exit(2)
    tmo = int(sys.argv[2]) if len(sys.argv) > 2 else 60
    sys.exit(run(sys.argv[1], timeout=tmo))
