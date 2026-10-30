# syntax=docker/dockerfile:1
FROM eclipse-temurin:25-jdk-noble AS builder
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates curl && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN curl -fL --retry 3 https://github.com/soulfiremc-com/SoulFire/releases/download/2.10.6/SoulFireDedicated-2.10.6.jar -o SoulFireDedicated.jar \
    && echo 'f033a3c1a88b6f3d303a4d9baee926cc8c3712069dcf30bcb631d368b25e5454  SoulFireDedicated.jar' | sha256sum -c -
COPY build-plugin.py ./
COPY plugin ./plugin
RUN --mount=type=cache,target=/build/cache python3 build-plugin.py --soulfire-jar SoulFireDedicated.jar --output afk-service-controls.jar --cache /build/cache

FROM eclipse-temurin:25-jre-noble
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl libstdc++6 libatomic1 libva-drm2 libva2 libdrm2 && rm -rf /var/lib/apt/lists/*
COPY --from=builder /build/SoulFireDedicated.jar /opt/soulfire/SoulFireDedicated.jar
COPY --from=builder /build/afk-service-controls.jar /opt/soulfire/afk-service-controls.jar
COPY entrypoint.sh /opt/soulfire/entrypoint.sh
RUN chmod +x /opt/soulfire/entrypoint.sh
WORKDIR /data
ENV JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=65 -XX:+UseG1GC"
VOLUME ["/data"]
EXPOSE 38765
ENTRYPOINT ["/opt/soulfire/entrypoint.sh"]
