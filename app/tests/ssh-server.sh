#!/bin/bash
# A real ssh server to check remote repositories against: an Alpine container with sshd, git and
# a small repository, logged into with a password (so the app's credential prompt is exercised),
# on 127.0.0.1:2222. Needs Docker. Stop it with: docker rm -f gg-ssh-test
#
#   app/tests/ssh-server.sh [shell]     shell: the account's login shell, sh (default) | bash | fish
#
# Then, with the Linux helpers built (app/scripts/build-remote.sh) and the app rebuilt:
#   GG_SELFTEST_SSH=ssh://dev@127.0.0.1:2222/home/dev/repo GG_SELFTEST_SSH_PASSWORD=gg-pass \
#   GG_REMOTE_SSH=app/tests/real-ssh.sh app/scripts/selftest.sh <app binary> <a local repository>
set -euo pipefail
shell="${1:-sh}"
case "$shell" in sh | bash | fish) ;; *) echo "shell: sh, bash or fish (not $shell)" >&2; exit 2 ;; esac
docker rm -f gg-ssh-test >/dev/null 2>&1 || true
docker run -d --name gg-ssh-test -p 127.0.0.1:2222:22 alpine sh -c "
	apk add -q openssh git $([ "$shell" = sh ] || echo "$shell") &&
	ssh-keygen -A >/dev/null &&
	adduser -D -s \$(command -v $shell) dev && echo dev:gg-pass | chpasswd 2>/dev/null &&
	echo 'Welcome to the test machine' > /etc/motd &&
	su dev -s /bin/sh -c 'cd && git init -q -b main repo && cd repo && git config user.name dev && git config user.email dev@test &&
		for i in 1 2 3; do echo \$i > file\$i.txt && git add . && git commit -qm \"commit \$i\"; done && git branch side HEAD~1' &&
	exec /usr/sbin/sshd -D -e -o PasswordAuthentication=yes" >/dev/null
for _ in $(seq 1 60); do
	docker logs gg-ssh-test 2>&1 | grep -q "Server listening" && { echo "sshd is up: ssh://dev@127.0.0.1:2222/home/dev/repo (password gg-pass, login shell $shell)"; exit 0; }
	sleep 0.5
done
docker logs gg-ssh-test >&2
exit 1
