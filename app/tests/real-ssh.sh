#!/bin/sh
# GG_REMOTE_SSH for the check against tests/ssh-server.sh: the real ssh, made to ask for the
# host key and the password every run - nothing is read from or written to ~/.ssh.
known="${TMPDIR:-/tmp}/gg-ssh-test-known-hosts.$PPID"
exec ssh -F /dev/null -o UserKnownHostsFile="$known" -o GlobalKnownHostsFile=/dev/null -o StrictHostKeyChecking=ask \
	-o PreferredAuthentications=password -o PubkeyAuthentication=no -o IdentityAgent=none "$@"
