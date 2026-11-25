#!/bin/sh
set -eu
exec java -Dfile.encoding=UTF-8 --add-opens=java.base/java.lang=ALL-UNNAMED --add-opens=java.base/java.lang.reflect=ALL-UNNAMED --add-opens=java.base/java.util=ALL-UNNAMED -cp '/opt/misa/*:/opt/misa/libs/*' SpiderHost /work/site.jar "$1" homeContent
