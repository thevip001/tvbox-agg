#!/bin/sh
set -eu
SPIDER_JAR=/opt/misa/fixture.jar
if [ -f /work/site.jar ]; then SPIDER_JAR=/work/site.jar; fi
exec java -Dfile.encoding=UTF-8 --add-opens=java.base/java.lang=ALL-UNNAMED --add-opens=java.base/java.lang.reflect=ALL-UNNAMED --add-opens=java.base/java.util=ALL-UNNAMED -cp '/opt/misa/*:/opt/misa/libs/*' SpiderHost "$SPIDER_JAR" "$1" homeContent
