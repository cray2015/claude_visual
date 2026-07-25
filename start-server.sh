#!/usr/bin/env bash
# Starts the receiver on macOS / Linux. (On Windows+WSL use start-server.cmd,
# which runs it as a Windows process so the phone can reach it directly.)
cd "$(dirname "$0")" || exit 1
exec node server/server.js
