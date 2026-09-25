#!/usr/bin/env bash
# Live logs from the PlatePress app on the glasses (camera, server link, discovery).
ADB="${ANDROID_HOME:-/Volumes/Extreme Pro/.android-sdk}/platform-tools/adb"
"$ADB" logcat -c
"$ADB" logcat -v time ServerLink:* CameraStreamer:* AndroidRuntime:E '*:S'
