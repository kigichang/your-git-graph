#!/bin/bash
# Run the app's built-in end-to-end self-test against a repository (or a folder of them) and
# print its log. Exit status 0 on "selftest: PASS".
#
#   app/scripts/selftest.sh <app binary> <repository or folder> [log file]
#
# The self-test WRITES to the repository (a temporary gg-selftest-* branch and file, both removed
# again) - point it at a scratch clone, not at a repository you care about. The recent list goes
# to a temporary GG_DATA_DIR, never to the user's. Extra environment (GG_SELFTEST_HTTP=…) is
# passed through.
set -u
app="$1"; repo="$2"; log="${3:-$(mktemp -t gg-selftest).log}"
data="${GG_DATA_DIR:-$(mktemp -d -t gg-selftest-data)}"

# The repository is also opened as one on another machine, through a stand-in for ssh that runs
# the helper on this Mac under a temporary home: the helper built beside a development binary
# (cargo build -p gg-remote), else the one embedded in the app (scripts/build-remote.sh).
# With GG_SELFTEST_SSH set (tests/ssh-server.sh prints how) the caller chose the real ssh.
if [ -z "${GG_SELFTEST_SSH:-}" ]; then
	export GG_REMOTE_SSH="$(cd "$(dirname "$0")/../tests" && pwd)/fake-ssh.sh"
	export GG_FAKE_HOME="$(mktemp -d -t gg-selftest-home)"
	[ -x "$(dirname "$app")/gg-remote" ] && export GG_REMOTE_HELPER="$(dirname "$app")/gg-remote"
fi

pkill -f "$app" 2>/dev/null
GG_DATA_DIR="$data" GG_SELFTEST=1 "$app" "$repo" > "$log" 2>&1 &
pid=$!
for _ in $(seq 1 240); do
	grep -qE "selftest: (PASS|FAIL)|boot failed|panicked" "$log" && break
	sleep 0.5
done
kill "$pid" 2>/dev/null
grep -v IMKCF "$log"
grep -q "selftest: PASS" "$log"
