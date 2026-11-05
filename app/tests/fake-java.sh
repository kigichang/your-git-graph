#!/bin/sh
# A stand-in for java (GG_PLANTUML_JAVA), for the tests and the self-test of the PlantUML blocks
# of the Markdown preview: it answers `java … -jar plantuml.jar -pipe -tsvg` with an SVG that
# holds its arguments and the diagram's source (escaped), so they can be checked.
#   a source containing gg-fake-fail  fails like java on a broken jar
#   a source containing gg-fake-hang  never answers
source="$(cat)"
case "$source" in
	*gg-fake-fail*) echo "Error: Invalid or corrupt jarfile" >&2; exit 1 ;;
	*gg-fake-hang*) exec sleep 600 ;;
esac
escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
printf '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="60"><title>%s</title><desc>%s</desc><rect width="320" height="60" fill="#ddd"/></svg>\n' \
	"$(printf '%s' "$*" | escape)" "$(printf '%s' "$source" | escape)"
