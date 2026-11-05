#!/bin/sh
# A stand-in for ssh (GG_REMOTE_SSH), for the tests and the self-test: it runs the command ssh
# would run on the other machine - the last argument - on this one, as that machine's login
# shell would (`sh -c`), under GG_FAKE_HOME so the helper is copied to a temporary place.
#   GG_FAKE_NOISE   printed first, like a greeting or a chatty shell profile
#   GG_FAKE_REFUSE  fail with this message instead, like a refused login
for last; do :; done
if [ -n "${GG_FAKE_REFUSE:-}" ]; then
	echo "$GG_FAKE_REFUSE" >&2
	exit 255
fi
[ -n "${GG_FAKE_NOISE:-}" ] && printf '%s' "$GG_FAKE_NOISE"
[ -n "${GG_FAKE_HOME:-}" ] && export HOME="$GG_FAKE_HOME"
unset XDG_CACHE_HOME
exec sh -c "$last"
