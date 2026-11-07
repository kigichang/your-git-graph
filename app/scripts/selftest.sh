#!/bin/bash
# Run the app's built-in end-to-end self-test against a repository (or a folder of them) and
# print its log. Exit status 0 on "selftest: PASS".
#
#   app/scripts/selftest.sh <app binary> <repository or folder> [log file]
#
# The self-test WRITES to the repository (a temporary gg-selftest-* branch, a gg-selftest/
# directory, remotes named gg-selftest-*, all removed again) - point it at a scratch clone, not
# at a repository you care about. The recent list and the settings go to a temporary
# GG_DATA_DIR, never to yours. Extra environment is passed through:
#   GG_SELFTEST_HTTP=<url>        an HTTP address that asks for a name and a password, for the
#                                 credential prompts; without it, tests/basic_auth_server.py is
#                                 started here (python3) and must see the name and password typed
#   GG_SELFTEST_SSH=…             the repository through the real ssh (tests/ssh-server.sh says how)
#   GG_SELFTEST_PLANTUML_JAR=…    PlantUML blocks through that jar and the real java
set -u
app="$1"; repo="$2"; log="${3:-$(mktemp -t gg-selftest).log}"
data="${GG_DATA_DIR:-$(mktemp -d -t gg-selftest-data)}"
tests="$(cd "$(dirname "$0")/../tests" && pwd)"

# The repository is also opened as one on another machine, through a stand-in for ssh that runs
# the helper on this Mac under a temporary home: the helper built beside a development binary
# (cargo build -p gg-remote), else the one embedded in the app (scripts/build-remote.sh).
# With GG_SELFTEST_SSH set (tests/ssh-server.sh prints how) the caller chose the real ssh.
if [ -z "${GG_SELFTEST_SSH:-}" ]; then
	export GG_REMOTE_SSH="$tests/fake-ssh.sh"
	export GG_FAKE_HOME="$(mktemp -d -t gg-selftest-home)"
	[ -x "$(dirname "$app")/gg-remote" ] && export GG_REMOTE_HELPER="$(dirname "$app")/gg-remote"
fi

# PlantUML blocks of the Markdown preview are drawn by a stand-in for java (no JDK, no jar
# needed) - or, with GG_SELFTEST_PLANTUML_JAR=<plantuml.jar>, by that jar and the real java.
if [ -z "${GG_SELFTEST_PLANTUML_JAR:-}" ]; then
	export GG_PLANTUML_JAVA="${GG_PLANTUML_JAVA:-$tests/fake-java.sh}"
fi

# The credential prompts: a server on this Mac that wants a name and a password, logs what it is
# given (decoded) and refuses it. The test must have typed gg-selftest / secret into the dialog.
httppid=""; authlog=""
if [ -z "${GG_SELFTEST_HTTP:-}" ] && command -v python3 >/dev/null; then
	portfile="$(mktemp -t gg-selftest-port)"; authlog="$(mktemp -t gg-selftest-auth)"
	python3 -I "$tests/basic_auth_server.py" "$portfile" "$authlog" &
	httppid=$!
	for _ in $(seq 1 50); do [ -s "$portfile" ] && break; sleep 0.1; done
	[ -s "$portfile" ] && export GG_SELFTEST_HTTP="http://127.0.0.1:$(cat "$portfile")/gg-selftest.git"
fi

pkill -f "$app" 2>/dev/null
GG_DATA_DIR="$data" GG_SELFTEST=1 "$app" "$repo" > "$log" 2>&1 &
pid=$!
for _ in $(seq 1 600); do
	grep -qE "selftest: (PASS|FAIL)|boot failed|panicked" "$log" && break
	sleep 0.5
done
kill "$pid" 2>/dev/null
[ -n "$httppid" ] && kill "$httppid" 2>/dev/null
grep -v IMKCF "$log"
status=0
grep -q "selftest: PASS" "$log" || status=1
if [ -n "$authlog" ]; then
	# Once from the app's own git, once through the helper: the dialog's answers reached the server.
	n="$(grep -c '^auth: gg-selftest:secret$' "$authlog")"
	echo "askpass: the server saw the name and password $n time(s)"
	[ "$n" -ge 1 ] || status=1
fi
# log.enabled: the line logged while it was on is in the session log, the others are not.
if grep -q "selftest: PASS" "$log"; then
	if grep -q "selftest: session log marker" "$data/session.log" 2>/dev/null && ! grep -q "selftest: graph:" "$data/session.log" 2>/dev/null; then
		echo "session log: written only while log.enabled was on"
	else
		echo "session log: the marker is missing or other lines got in"; status=1
	fi
fi
exit $status
