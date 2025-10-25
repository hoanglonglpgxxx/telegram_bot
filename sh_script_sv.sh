#!/bin/bash

# --- Redis config for nodejs/index.js---
export REDIS_HOST="192.168.1.130"
export REDIS_PORT=6379
export REDIS_PASSWORD="Redishvqp323"
export SSL_KEY_PATH="/u01/colombo/www/keys/socket.io/privkey.pem"
export SSL_CERT_PATH="/u01/colombo/www/keys/socket.io/fullchain.pem"
export PORT=3301

# --- Forever config ---
export PATH=/u01/colombo/usr/bin:/u01/colombo/www/colombo4/nodejs/node_modules/.bin:$PATH

FOREVER="/u01/colombo/www/colombo4/nodejs/node_modules/forever/bin/forever"
NODEJS_APP="/u01/colombo/www/colombo4/nodejs/index.js"
APP_ID="vsystem-chat-socketio"
LOGFILE="/u01/colombo/www/crontab/log/vhv_cronjob_$APP_ID.log"

echo "User colombo only!!!"

case "$1" in
  start)
    "$FOREVER" --uid "$APP_ID" -a -e "$LOGFILE" -o "$LOGFILE" --no-file start "$NODEJS_APP"
    echo "vsystem chat (by nodejs socket.io) started"
    echo "Check log at $LOGFILE"
    ;;
  stop)
    "$FOREVER" stop "$APP_ID" || {
		#kill process index.js if no vsystem-chat-socketio (for old version /s/chat)
      echo "vsystem-chat-socketio is not found. Stop all $NODEJS_APP..."
      pkill -f "$NODEJS_APP"
    }
    echo "vsystem chat (by nodejs socket.io) stopped"
    ;;
  status)
    if "$FOREVER" list | grep "$APP_ID" > /dev/null; then
      echo "$(date '+%y-%m-%d %H:%M:%S') chat process running"
    else
      echo "$(date '+%y-%m-%d %H:%M:%S') chat process down"
    fi
    ;;
  restart)
    "$FOREVER" restart --no-file "$APP_ID" || {
      # call restart with full params if restart fail
      "$FOREVER" --uid "$APP_ID" -a -e "$LOGFILE" -o "$LOGFILE" --no-file start "$NODEJS_APP"
    }
    echo "vsystem chat (by nodejs socket.io) restarted"
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status}"
    ;;
esac