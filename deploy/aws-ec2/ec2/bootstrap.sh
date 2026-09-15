#!/bin/bash
# Prepares an Amazon Linux 2023 EC2 instance to run one client's Docent.
# Fill in the three values below, then use this file as the instance's user data
# (or run it once as root through Session Manager). It installs nothing from outside the OS repos.
#
# Afterwards the host has:
#   /etc/docent/config           AWS_REGION, DOCENT_CLIENT, DOCENT_SECRET_ID (root only)
#   /opt/docent/deploy.sh        pulls an image from ECR, fetches the token, restarts the service
#   /opt/docent/run.sh           runs the container (called by systemd)
#   docent.service               keeps Docent running and restarts it on failure or reboot
#   /var/lib/docent/logs         request log and review queue, owned by the container user (uid 1000)
set -euo pipefail

AWS_REGION="<AWS_REGION>"
DOCENT_CLIENT="<CLIENT_ID>"
DOCENT_SECRET_ID="docent/<CLIENT_ID>/token"

case "$AWS_REGION $DOCENT_CLIENT $DOCENT_SECRET_ID" in
  *"<"*) echo "Fill in AWS_REGION, DOCENT_CLIENT and DOCENT_SECRET_ID at the top of bootstrap.sh first." >&2; exit 1 ;;
esac

dnf install -y docker logrotate
systemctl enable --now docker

install -d -m 755 /opt/docent
install -d -m 700 /etc/docent
install -d -m 750 -o 1000 -g 1000 /var/lib/docent/logs

cat > /etc/docent/config <<EOF
AWS_REGION=$AWS_REGION
DOCENT_CLIENT=$DOCENT_CLIENT
DOCENT_SECRET_ID=$DOCENT_SECRET_ID
EOF
chmod 600 /etc/docent/config

cat > /opt/docent/deploy.sh <<'DEPLOY'
#!/bin/bash
# Usage: /opt/docent/deploy.sh <ecr-image-uri>
# Pulls the image, writes the token to a root-only env file, restarts Docent and waits for /healthz.
set -euo pipefail
IMAGE="${1:?usage: deploy.sh <ecr-image-uri>}"
source /etc/docent/config

aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "${IMAGE%%/*}"
docker pull "$IMAGE"

umask 077
TOKEN="$(aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$DOCENT_SECRET_ID" --query SecretString --output text)"
if [ "${#TOKEN}" -lt 24 ]; then
  echo "The secret $DOCENT_SECRET_ID must hold a token of at least 24 characters." >&2
  exit 1
fi
printf 'DOCENT_TOKEN=%s\nDOCENT_CLIENT=%s\n' "$TOKEN" "$DOCENT_CLIENT" > /etc/docent/docent.env.new
mv /etc/docent/docent.env.new /etc/docent/docent.env
unset TOKEN
printf '%s\n' "$IMAGE" > /etc/docent/image

systemctl restart docent
for _ in $(seq 1 45); do
  if HEALTH="$(curl -fsS http://127.0.0.1:8080/healthz 2>/dev/null)"; then
    echo "Docent is healthy: $HEALTH"
    exit 0
  fi
  sleep 2
done
echo "Docent did not become healthy within 90 seconds." >&2
journalctl -u docent -n 60 --no-pager >&2
exit 1
DEPLOY
chmod 700 /opt/docent/deploy.sh

cat > /opt/docent/run.sh <<'RUN'
#!/bin/bash
set -euo pipefail
IMAGE="$(cat /etc/docent/image)"
exec /usr/bin/docker run --name docent --rm \
  --env-file /etc/docent/docent.env \
  -p 8080:8080 \
  -v /var/lib/docent/logs:/app/logs \
  --memory 1g \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --log-driver journald \
  "$IMAGE"
RUN
chmod 700 /opt/docent/run.sh

cat > /etc/systemd/system/docent.service <<'UNIT'
[Unit]
Description=Docent MCP server
After=docker.service network-online.target
Requires=docker.service
# Nothing to run until the first deploy writes the image name.
ConditionPathExists=/etc/docent/image

[Service]
ExecStartPre=-/usr/bin/docker rm -f docent
ExecStart=/opt/docent/run.sh
ExecStop=/usr/bin/docker stop docent
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

# The request log holds submitted code: rotate it on the company's retention schedule.
# The review queue (reviews.jsonl) is never rotated, so no decision is lost.
cat > /etc/logrotate.d/docent <<'ROTATE'
/var/lib/docent/logs/*/requests.jsonl {
  weekly
  rotate 12
  compress
  missingok
  notifempty
  copytruncate
}
ROTATE

systemctl daemon-reload
systemctl enable docent
echo "Docent host ready for $DOCENT_CLIENT. Deploy with: sudo /opt/docent/deploy.sh <ecr-image-uri>"
