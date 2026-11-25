FROM eclipse-temurin:17-jdk-jammy
ARG MISATV_COMMIT=fd0106a9d1a450d46925ccb8cf47feef3acf6350
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/misa
RUN set -eux; \
  curl -fsSL "https://raw.githubusercontent.com/yagami-hue/MisaTV/${MISATV_COMMIT}/assets/jvm/spider-host.jar" -o spider-host.jar; \
  curl -fsSL "https://raw.githubusercontent.com/yagami-hue/MisaTV/${MISATV_COMMIT}/assets/jvm/stubs.jar" -o stubs.jar; \
  curl -fsSL "https://raw.githubusercontent.com/yagami-hue/MisaTV/${MISATV_COMMIT}/assets/jvm/prefs-shim.jar" -o prefs-shim.jar; \
  curl -fsSL "https://raw.githubusercontent.com/yagami-hue/MisaTV/${MISATV_COMMIT}/assets/jvm/okhttp4-compat.jar" -o okhttp4-compat.jar; \
  mkdir -p libs; \
  for path in \
    com/squareup/okhttp3/okhttp/3.14.9/okhttp-3.14.9.jar \
    com/squareup/okio/okio/1.17.5/okio-1.17.5.jar \
    com/google/code/gson/gson/2.10.1/gson-2.10.1.jar \
    org/jsoup/jsoup/1.17.2/jsoup-1.17.2.jar \
    org/json/json/20180813/json-20180813.jar \
    org/slf4j/slf4j-api/2.0.16/slf4j-api-2.0.16.jar \
    org/slf4j/slf4j-simple/2.0.16/slf4j-simple-2.0.16.jar \
    org/bouncycastle/bcprov-jdk18on/1.78.1/bcprov-jdk18on-1.78.1.jar \
    org/xerial/sqlite-jdbc/3.46.1.0/sqlite-jdbc-3.46.1.0.jar; do \
      curl -fsSL "https://maven.aliyun.com/repository/public/${path}" -o "libs/$(basename "${path}")"; \
    done
COPY fixture-src/ /tmp/fixture-src/
RUN mkdir -p /tmp/classes && javac -cp '/opt/misa/stubs.jar:/opt/misa/libs/*' -d /tmp/classes /tmp/fixture-src/com/github/catvod/spider/RuntimeFixture.java && jar --create --file /opt/misa/fixture.jar -C /tmp/classes .
COPY entrypoint.sh /opt/misa/entrypoint.sh
RUN chmod 0555 /opt/misa/entrypoint.sh && chmod -R a+rX /opt/misa
USER 65532:65532
ENTRYPOINT ["/opt/misa/entrypoint.sh"]
