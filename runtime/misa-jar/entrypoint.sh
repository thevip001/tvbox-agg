#!/bin/sh
set -eu
SPIDER_JAR=/opt/misa/fixture.jar
if [ -f /work/site.jar ]; then SPIDER_JAR=/work/site.jar; fi
exec java -Dfile.encoding=UTF-8 -Dhttp.proxyHost=egress-proxy -Dhttp.proxyPort=3128 -Dhttps.proxyHost=egress-proxy -Dhttps.proxyPort=3128 -Dhttp.nonProxyHosts="localhost|127.*|[::1]" --add-opens=java.base/java.lang=ALL-UNNAMED --add-opens=java.base/java.lang.reflect=ALL-UNNAMED --add-opens=java.base/java.util=ALL-UNNAMED -cp '/opt/misa/*:/opt/misa/libs/*' SpiderHost "$SPIDER_JAR" "$1" homeContent
