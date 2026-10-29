#!/bin/sh
set -eu
# SoulFire's Fabric game directory is <baseDir>/minecraft, not <baseDir>.
# Copy on every boot so existing volumes receive plugin updates too.
umask 077
mkdir -p /data/minecraft/mods
cp /opt/soulfire/afk-service-controls.jar /data/minecraft/mods/afk-service-controls.jar.tmp
mv /data/minecraft/mods/afk-service-controls.jar.tmp /data/minecraft/mods/afk-service-controls.jar
exec java -Dsf.baseDir=/data -Dsf.grpc.host=0.0.0.0 -Dsf.grpc.port=38765 -jar /opt/soulfire/SoulFireDedicated.jar "$@"
