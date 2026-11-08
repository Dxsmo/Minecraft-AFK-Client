# syntax=docker/dockerfile:1
FROM eclipse-temurin:25-jdk-noble AS builder
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates curl && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN curl -fL --retry 3 https://github.com/soulfiremc-com/SoulFire/releases/download/2.10.7/SoulFireDedicated-2.10.7.jar -o SoulFireDedicated.jar \
    && echo '1afded9628c9732f0a0c982894e9fb023a7d94ab24f9b7e3e8db1cb96f16b4ea  SoulFireDedicated.jar' | sha256sum -c -
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
# Keep software rendering from spawning a worker per host CPU and crowding out
# account ticks/network handling. Operators can override this Mesa setting.
ENV LP_NUM_THREADS=2
VOLUME ["/data"]
EXPOSE 38765
ENTRYPOINT ["/opt/soulfire/entrypoint.sh"]
