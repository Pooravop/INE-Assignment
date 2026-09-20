#!/bin/sh
# Container entrypoint: give Chromium a virtual display so it can run HEADED (the store's
# session check passes real, headed browsers more often), then start the API.
#
# Xvfb is started explicitly instead of via `xvfb-run`, which can hang forever inside
# containers when its readiness signal is swallowed. If the display does not come up, the
# API still starts, in headless mode, and says so in the log.

echo "entrypoint: starting Xvfb on :99"
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &

i=0
while [ "$i" -lt 25 ] && [ ! -e /tmp/.X11-unix/X99 ]; do
  sleep 0.2
  i=$((i + 1))
done

if [ -e /tmp/.X11-unix/X99 ]; then
  export DISPLAY=:99
  echo "entrypoint: virtual display :99 is ready (headed scraping)"
else
  echo "entrypoint: Xvfb did not start; falling back to headless scraping"
  cat /tmp/xvfb.log 2>/dev/null
  unset DISPLAY
  export SCRAPE_HEADED=0
fi

exec node dist/server.js
